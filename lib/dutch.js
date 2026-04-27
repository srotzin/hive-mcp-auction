/**
 * Dutch descent math — pure, deterministic, clock-driven.
 *
 * current_price(t) is a pure function of (asking_usd, opened_at, t). No
 * RNG, no DB read, no clock skew tolerance baked in. Two callers with the
 * same arguments get the same number to the cent. That is the whole point —
 * the public envelope alone is provably fair.
 *
 *   start_price = asking_usd * START_MULT       (default 5x asking)
 *   floor_price = asking_usd * FLOOR_PCT        (default 50% of asking)
 *   drop_pct    = DROP_PCT                      (default 5% per tick)
 *   interval_s  = INTERVAL_S                    (default 30s per tick)
 *
 *   ticks(t)        = floor((t - opened_at) / interval_s)
 *   current_price(t)= max(floor_price, start_price * (1 - drop_pct) ** ticks(t))
 *
 * After ~28 ticks the curve hits the floor. Caller (auctions.js) decides what
 * to do with an at-floor auction — typically: close as expired.
 */

const N = (k, d) => {
  const v = parseFloat(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const DUTCH = {
  START_MULT:    N('AUCTION_START_MULT',  5.0),
  FLOOR_PCT:     N('AUCTION_FLOOR_PCT',   0.50),
  DROP_PCT:      N('AUCTION_DROP_PCT',    0.05),
  INTERVAL_S:    N('AUCTION_INTERVAL_S',  30),
  MAX_DURATION_S: N('AUCTION_MAX_DURATION_S', 14 * 60),
  CLAIM_WINDOW_S: N('AUCTION_CLAIM_WINDOW_S', 5),
};

export function curveParams(asking_usd) {
  const a = Number(asking_usd);
  if (!Number.isFinite(a) || a <= 0) throw new Error('asking_usd must be positive number');
  return {
    asking_usd: a,
    start_price_usd: round6(a * DUTCH.START_MULT),
    floor_price_usd: round6(a * DUTCH.FLOOR_PCT),
    drop_pct: DUTCH.DROP_PCT,
    interval_s: DUTCH.INTERVAL_S,
    max_duration_s: DUTCH.MAX_DURATION_S,
  };
}

export function ticksElapsed(opened_at_ms, t_ms) {
  if (!Number.isFinite(opened_at_ms) || !Number.isFinite(t_ms)) return 0;
  if (t_ms < opened_at_ms) return 0;
  return Math.floor((t_ms - opened_at_ms) / (DUTCH.INTERVAL_S * 1000));
}

export function currentPrice({ asking_usd, opened_at_ms, now_ms = Date.now() }) {
  const { start_price_usd, floor_price_usd } = curveParams(asking_usd);
  const ticks = ticksElapsed(opened_at_ms, now_ms);
  const decayed = start_price_usd * Math.pow(1 - DUTCH.DROP_PCT, ticks);
  return round6(Math.max(floor_price_usd, decayed));
}

export function fullCurve({ asking_usd, opened_at_ms }) {
  const { start_price_usd, floor_price_usd } = curveParams(asking_usd);
  const out = [];
  const maxTicks = Math.ceil(DUTCH.MAX_DURATION_S / DUTCH.INTERVAL_S);
  for (let i = 0; i <= maxTicks; i++) {
    const decayed = start_price_usd * Math.pow(1 - DUTCH.DROP_PCT, i);
    const price = Math.max(floor_price_usd, decayed);
    out.push({
      tick: i,
      offset_s: i * DUTCH.INTERVAL_S,
      ts: new Date(opened_at_ms + i * DUTCH.INTERVAL_S * 1000).toISOString(),
      price_usd: round6(price),
      at_floor: decayed <= floor_price_usd,
    });
    if (decayed <= floor_price_usd) break;
  }
  return out;
}

export function expiresAtMs(opened_at_ms) {
  return opened_at_ms + DUTCH.MAX_DURATION_S * 1000;
}

export function isExpired(opened_at_ms, now_ms = Date.now()) {
  return now_ms >= expiresAtMs(opened_at_ms);
}

export function priceMatches({ asking_usd, opened_at_ms, claim_at_price_usd, now_ms = Date.now() }) {
  const expected = currentPrice({ asking_usd, opened_at_ms, now_ms });
  const window_ms = DUTCH.CLAIM_WINDOW_S * 1000;
  const expectedBack = currentPrice({ asking_usd, opened_at_ms, now_ms: Math.max(opened_at_ms, now_ms - window_ms) });
  const claim = Number(claim_at_price_usd);
  if (!Number.isFinite(claim)) return { ok: false, expected_usd: expected };
  const tolerance = 1e-6;
  if (Math.abs(claim - expected) <= tolerance) return { ok: true, expected_usd: expected };
  if (Math.abs(claim - expectedBack) <= tolerance) return { ok: true, expected_usd: expected };
  return { ok: false, expected_usd: expected };
}

function round6(x) { return Number(Number(x).toFixed(6)); }
