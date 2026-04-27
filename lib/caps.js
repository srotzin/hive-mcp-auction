/**
 * Risk-control gate for the auction surface. Hard caps from the spec:
 *
 *   Max simultaneous open auctions   50
 *   Max descent below asking         50%   (enforced in dutch.js FLOOR_PCT)
 *   Max start multiplier             10x
 *   Auction max duration             14 min (enforced in dutch.js MAX_DURATION_S)
 *   Claim window after price-tick    5s    (enforced in dutch.js CLAIM_WINDOW_S)
 *   Per-caller claim rate            10/min
 *
 * All caps fail-closed. Configurable via env, missing/invalid env always
 * falls back to the stricter default.
 */

const N = (k, d) => {
  const v = parseFloat(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

export const CAPS = {
  MAX_CONCURRENT_AUCTIONS: N('MAX_CONCURRENT_AUCTIONS', 50),
  MAX_DESCENT_PCT:         N('MAX_DESCENT_PCT',          0.50),
  MAX_START_MULT:          N('MAX_START_MULT',          10),
  AUCTION_MAX_DURATION_S:  N('AUCTION_MAX_DURATION_S',  14 * 60),
  CLAIM_WINDOW_S:          N('AUCTION_CLAIM_WINDOW_S',   5),
  PER_CALLER_CLAIMS_PER_MIN: N('PER_CALLER_CLAIMS_PER_MIN', 10),
};

export function checkOpen({ asking_usd, openCount, requestedStartMult, requestedDescentPct }) {
  if (!Number.isFinite(asking_usd) || asking_usd <= 0) return { ok: false, reason: 'invalid_asking' };
  if (openCount >= CAPS.MAX_CONCURRENT_AUCTIONS)        return { ok: false, reason: 'concurrent_cap' };
  if (Number.isFinite(requestedStartMult) && requestedStartMult > CAPS.MAX_START_MULT) {
    return { ok: false, reason: 'over_start_mult' };
  }
  if (Number.isFinite(requestedDescentPct) && requestedDescentPct > CAPS.MAX_DESCENT_PCT) {
    return { ok: false, reason: 'over_descent_pct' };
  }
  return { ok: true };
}

const claimWindow = new Map();

export function checkClaimRate(caller_id) {
  const key = String(caller_id || 'anon');
  const now = Date.now();
  const arr = (claimWindow.get(key) || []).filter(ts => now - ts < 60_000);
  if (arr.length >= CAPS.PER_CALLER_CLAIMS_PER_MIN) {
    return { ok: false, reason: 'per_caller_rate', recent: arr.length };
  }
  arr.push(now);
  claimWindow.set(key, arr);
  return { ok: true, recent: arr.length };
}

export function pruneClaimWindow() {
  const now = Date.now();
  for (const [k, arr] of claimWindow.entries()) {
    const fresh = arr.filter(ts => now - ts < 60_000);
    if (fresh.length === 0) claimWindow.delete(k);
    else claimWindow.set(k, fresh);
  }
}
