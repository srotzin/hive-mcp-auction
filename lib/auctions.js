/**
 * Auction state machine.
 *
 * open  → claimed (atomic UPDATE on first valid claim)
 * open  → expired (background sweep when now > expires_at)
 *
 * The state machine is one-shot per auction id. There is no resurrection.
 */

import crypto from 'node:crypto';
import {
  curveParams, currentPrice, fullCurve, expiresAtMs,
  isExpired, priceMatches, DUTCH,
} from './dutch.js';
import {
  insertAuction, getAuction, listOpenAuctions, countOpenAuctions,
  tryClaimAtomic, markExpired, recordClaimAttempt, getClaimByIdempotency,
  markClaimVerified,
} from './ledger.js';
import { CAPS, checkOpen, checkClaimRate } from './caps.js';

function newAuctionId() {
  return 'auct_' + crypto.randomBytes(8).toString('hex');
}

export function openAuction({ shim, asking_usd, max_descent_pct, created_by, meta }) {
  const ask = Number(asking_usd);
  const guard = checkOpen({
    asking_usd: ask,
    openCount: countOpenAuctions(),
    requestedStartMult: undefined,
    requestedDescentPct: max_descent_pct,
  });
  if (!guard.ok) return { ok: false, error: 'cap', reason: guard.reason };

  const params = curveParams(ask);
  const opened_at_ms = Date.now();
  const expires_at_ms = expiresAtMs(opened_at_ms);
  const id = newAuctionId();

  insertAuction({
    id,
    shim: shim || null,
    asking_usd: params.asking_usd,
    start_price_usd: params.start_price_usd,
    floor_price_usd: params.floor_price_usd,
    drop_pct: params.drop_pct,
    interval_s: params.interval_s,
    opened_at: new Date(opened_at_ms).toISOString(),
    opened_at_ms,
    expires_at: new Date(expires_at_ms).toISOString(),
    expires_at_ms,
    created_by: created_by || null,
    meta: meta || null,
  });

  return {
    ok: true,
    auction: serialize({
      id, shim, asking_usd: params.asking_usd,
      start_price_usd: params.start_price_usd,
      floor_price_usd: params.floor_price_usd,
      drop_pct: params.drop_pct, interval_s: params.interval_s,
      opened_at_ms, expires_at_ms, state: 'open',
    }),
    curve: fullCurve({ asking_usd: params.asking_usd, opened_at_ms }),
  };
}

export function getCurrent(auction_id, now_ms = Date.now()) {
  const a = getAuction(auction_id);
  if (!a) return { ok: false, error: 'not_found' };
  const cur = currentPrice({ asking_usd: a.asking_usd, opened_at_ms: a.opened_at_ms, now_ms });
  return {
    ok: true,
    auction: serialize(a),
    current_price_usd: cur,
    at_floor: cur <= a.floor_price_usd + 1e-9,
    expired: isExpired(a.opened_at_ms, now_ms),
  };
}

export function getCurve(auction_id) {
  const a = getAuction(auction_id);
  if (!a) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    auction: serialize(a),
    curve: fullCurve({ asking_usd: a.asking_usd, opened_at_ms: a.opened_at_ms }),
  };
}

/**
 * Attempt to claim. State transitions happen here. Idempotency key is
 * unique-indexed; replays return the original claim row.
 *
 *   200  winner: true                         (won the slot)
 *   409  winner: false  reason: already_claimed
 *   410  winner: false  reason: auction_expired
 *   422  winner: false  reason: price_mismatch
 */
export function claim({ auction_id, claim_at_price_usd, idempotency_key, caller_id, tx_hash }) {
  const a = getAuction(auction_id);
  if (!a) return { http: 404, body: { winner: false, reason: 'not_found' } };

  if (idempotency_key) {
    const replay = getClaimByIdempotency(idempotency_key);
    if (replay) {
      const http = replay.winner ? 200 : (replay.reason === 'already_claimed' ? 409 : replay.reason === 'auction_expired' ? 410 : 422);
      return {
        http,
        body: {
          winner: !!replay.winner,
          reason: replay.reason || null,
          slot_token: replay.slot_token || null,
          idempotent_replay: true,
        },
      };
    }
  }

  const rate = checkClaimRate(caller_id);
  if (!rate.ok) return { http: 429, body: { winner: false, reason: rate.reason, recent: rate.recent } };

  const now_ms = Date.now();
  if (a.state !== 'open') {
    const reason = a.state === 'claimed' ? 'already_claimed' : 'auction_expired';
    recordClaimAttempt({ auction_id, claim_at_price_usd, idempotency_key, caller_id, tx_hash, slot_token: null, winner: false, reason });
    const http = reason === 'already_claimed' ? 409 : 410;
    return { http, body: { winner: false, reason } };
  }

  if (isExpired(a.opened_at_ms, now_ms)) {
    markExpired(auction_id, a.floor_price_usd);
    recordClaimAttempt({ auction_id, claim_at_price_usd, idempotency_key, caller_id, tx_hash, slot_token: null, winner: false, reason: 'auction_expired' });
    return { http: 410, body: { winner: false, reason: 'auction_expired' } };
  }

  const match = priceMatches({
    asking_usd: a.asking_usd,
    opened_at_ms: a.opened_at_ms,
    claim_at_price_usd,
    now_ms,
  });
  if (!match.ok) {
    recordClaimAttempt({ auction_id, claim_at_price_usd, idempotency_key, caller_id, tx_hash, slot_token: null, winner: false, reason: 'price_mismatch' });
    return { http: 422, body: { winner: false, reason: 'price_mismatch', current_price_usd: match.expected_usd } };
  }

  const atomic = tryClaimAtomic(auction_id);
  if (!atomic.won) {
    recordClaimAttempt({ auction_id, claim_at_price_usd, idempotency_key, caller_id, tx_hash, slot_token: null, winner: false, reason: 'already_claimed' });
    return { http: 409, body: { winner: false, reason: 'already_claimed' } };
  }

  const slot_token = 'slot_' + crypto.randomBytes(16).toString('hex');
  const written = recordClaimAttempt({
    auction_id, claim_at_price_usd: match.expected_usd, idempotency_key,
    caller_id, tx_hash, slot_token, winner: true, reason: null, verified: 0,
  });

  return {
    http: 200,
    body: {
      winner: true,
      slot_token,
      claim_at_price_usd: match.expected_usd,
      expires_in_s: 60,
      auction_id,
      claim_id: written.id || null,
    },
  };
}

export function sweepExpired(now_ms = Date.now()) {
  const open = listOpenAuctions();
  let n = 0;
  for (const a of open) {
    if (isExpired(a.opened_at_ms, now_ms)) {
      const changes = markExpired(a.id, a.floor_price_usd);
      if (changes) n += 1;
    }
  }
  return n;
}

export function reportClaimVerification(claim_id, verified) {
  markClaimVerified(claim_id, verified);
}

function serialize(a) {
  return {
    id: a.id,
    shim: a.shim || null,
    state: a.state,
    asking_usd: a.asking_usd,
    start_price_usd: a.start_price_usd,
    floor_price_usd: a.floor_price_usd,
    drop_pct: a.drop_pct,
    interval_s: a.interval_s,
    opened_at: a.opened_at || new Date(a.opened_at_ms).toISOString(),
    expires_at: a.expires_at || new Date(a.expires_at_ms).toISOString(),
    max_duration_s: DUTCH.MAX_DURATION_S,
  };
}
