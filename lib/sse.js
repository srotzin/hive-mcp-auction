/**
 * Server-Sent-Events fanout for live descent curves.
 *
 * One subscriber set per auction id. Bounded by CAPS.MAX_CONCURRENT_AUCTIONS
 * because we only emit ticks for auctions in `auctions` table state='open'.
 *
 * Each subscriber gets the full curve on connect, then a price tick every
 * INTERVAL_S until claimed/expired. Connections close cleanly on state
 * transition.
 */

import { currentPrice, fullCurve, isExpired, DUTCH } from './dutch.js';
import { getAuction, recordDescentTick } from './ledger.js';

const subs = new Map();

export function attachSubscriber(auction_id, res) {
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const a = getAuction(auction_id);
  if (!a) {
    write(res, 'error', { error: 'not_found', auction_id });
    return res.end();
  }

  write(res, 'open', {
    auction_id,
    asking_usd: a.asking_usd,
    start_price_usd: a.start_price_usd,
    floor_price_usd: a.floor_price_usd,
    drop_pct: a.drop_pct,
    interval_s: a.interval_s,
    opened_at: a.opened_at,
    expires_at: a.expires_at,
    state: a.state,
    curve: fullCurve({ asking_usd: a.asking_usd, opened_at_ms: a.opened_at_ms }),
  });

  if (a.state !== 'open') {
    write(res, 'closed', { state: a.state, auction_id });
    return res.end();
  }

  const set = subs.get(auction_id) || new Set();
  set.add(res);
  subs.set(auction_id, set);

  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { /* ignore */ }
  }, 25_000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const s = subs.get(auction_id);
    if (s) {
      s.delete(res);
      if (s.size === 0) subs.delete(auction_id);
    }
  });
}

export function broadcastTick(auction_id) {
  const set = subs.get(auction_id);
  const a = getAuction(auction_id);
  if (!a) return 0;
  if (a.state !== 'open') {
    if (set) {
      for (const res of set) {
        try { write(res, 'closed', { state: a.state, auction_id }); res.end(); } catch { /* ignore */ }
      }
      subs.delete(auction_id);
    }
    return 0;
  }
  if (isExpired(a.opened_at_ms)) {
    if (set) {
      for (const res of set) {
        try { write(res, 'closed', { state: 'expired', auction_id }); res.end(); } catch { /* ignore */ }
      }
      subs.delete(auction_id);
    }
    return 0;
  }
  const now_ms = Date.now();
  const price = currentPrice({ asking_usd: a.asking_usd, opened_at_ms: a.opened_at_ms, now_ms });
  const tick = Math.floor((now_ms - a.opened_at_ms) / (DUTCH.INTERVAL_S * 1000));
  recordDescentTick(auction_id, tick, price);
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const res of set) {
    try {
      write(res, 'tick', { auction_id, tick, price_usd: price, ts: new Date(now_ms).toISOString() });
      n += 1;
    } catch { /* ignore */ }
  }
  return n;
}

export function notifyClaimed(auction_id, slot_token) {
  const set = subs.get(auction_id);
  if (!set) return;
  for (const res of set) {
    try {
      write(res, 'claimed', { auction_id, slot_token: slot_token ? '***' : null });
      res.end();
    } catch { /* ignore */ }
  }
  subs.delete(auction_id);
}

export function subscriberCount(auction_id) {
  return subs.get(auction_id)?.size || 0;
}

function write(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
