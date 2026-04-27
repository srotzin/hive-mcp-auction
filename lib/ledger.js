/**
 * SQLite ledger at /tmp/auction.db. Tables: auctions, claims, descents, expires.
 *
 * /tmp survives Render restart for the lifetime of the instance — daily
 * rollups are pushed to hivemorph at midnight ET so a cold start never loses
 * realized auction revenue history.
 *
 * Race-safety on claim is enforced by an atomic UPDATE … WHERE state='open'
 * returning row count. The first UPDATE that touches a row wins.
 */

import Database from 'better-sqlite3';

const DB_PATH = process.env.AUCTION_DB || '/tmp/auction.db';

let db;
export function openDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auctions (
      id TEXT PRIMARY KEY,
      shim TEXT,
      asking_usd REAL,
      start_price_usd REAL,
      floor_price_usd REAL,
      drop_pct REAL,
      interval_s INTEGER,
      opened_at TEXT,
      opened_at_ms INTEGER,
      expires_at TEXT,
      expires_at_ms INTEGER,
      state TEXT,
      created_by TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auctions_state ON auctions(state);
    CREATE INDEX IF NOT EXISTS idx_auctions_opened ON auctions(opened_at_ms);

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id TEXT,
      ts TEXT,
      claim_at_price_usd REAL,
      idempotency_key TEXT UNIQUE,
      caller_id TEXT,
      tx_hash TEXT,
      slot_token TEXT,
      winner INTEGER,
      reason TEXT,
      verified INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_claims_auction ON claims(auction_id);
    CREATE INDEX IF NOT EXISTS idx_claims_ts ON claims(ts);

    CREATE TABLE IF NOT EXISTS descents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id TEXT,
      ts TEXT,
      tick INTEGER,
      price_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_descents_auction ON descents(auction_id);

    CREATE TABLE IF NOT EXISTS expires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id TEXT UNIQUE,
      ts TEXT,
      final_floor_price_usd REAL
    );
  `);
  return db;
}

export function insertAuction(a) {
  const d = openDb();
  d.prepare(`
    INSERT INTO auctions (
      id, shim, asking_usd, start_price_usd, floor_price_usd, drop_pct,
      interval_s, opened_at, opened_at_ms, expires_at, expires_at_ms,
      state, created_by, meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    a.id, a.shim || null, a.asking_usd, a.start_price_usd, a.floor_price_usd,
    a.drop_pct, a.interval_s, a.opened_at, a.opened_at_ms,
    a.expires_at, a.expires_at_ms, a.created_by || null,
    a.meta ? JSON.stringify(a.meta).slice(0, 4096) : null,
  );
}

export function getAuction(id) {
  const d = openDb();
  return d.prepare(`SELECT * FROM auctions WHERE id = ?`).get(id) || null;
}

export function listOpenAuctions() {
  const d = openDb();
  return d.prepare(`SELECT * FROM auctions WHERE state = 'open' ORDER BY opened_at_ms DESC`).all();
}

export function countOpenAuctions() {
  const d = openDb();
  const row = d.prepare(`SELECT COUNT(*) AS n FROM auctions WHERE state = 'open'`).get();
  return row?.n || 0;
}

/**
 * Race-safe atomic claim. Only the first UPDATE that touches an open row wins.
 * Returns { won: boolean, row_count }.
 */
export function tryClaimAtomic(auction_id) {
  const d = openDb();
  const info = d.prepare(`UPDATE auctions SET state = 'claimed' WHERE id = ? AND state = 'open'`).run(auction_id);
  return { won: info.changes === 1, row_count: info.changes };
}

export function markExpired(auction_id, final_floor_price_usd) {
  const d = openDb();
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    const info = d.prepare(`UPDATE auctions SET state = 'expired' WHERE id = ? AND state = 'open'`).run(auction_id);
    if (info.changes === 1) {
      d.prepare(`INSERT OR IGNORE INTO expires (auction_id, ts, final_floor_price_usd) VALUES (?, ?, ?)`)
        .run(auction_id, now, final_floor_price_usd ?? null);
    }
    return info.changes;
  });
  return tx();
}

export function recordDescentTick(auction_id, tick, price_usd) {
  const d = openDb();
  d.prepare(`INSERT INTO descents (auction_id, ts, tick, price_usd) VALUES (?, ?, ?, ?)`)
    .run(auction_id, new Date().toISOString(), tick, price_usd);
}

export function recordClaimAttempt(c) {
  const d = openDb();
  try {
    const info = d.prepare(`
      INSERT INTO claims (
        auction_id, ts, claim_at_price_usd, idempotency_key, caller_id,
        tx_hash, slot_token, winner, reason, verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.auction_id,
      c.ts || new Date().toISOString(),
      c.claim_at_price_usd ?? null,
      c.idempotency_key || null,
      c.caller_id || null,
      c.tx_hash || null,
      c.slot_token || null,
      c.winner ? 1 : 0,
      c.reason || null,
      c.verified ? 1 : 0,
    );
    return { ok: true, id: info.lastInsertRowid };
  } catch (err) {
    if (String(err.message).includes('UNIQUE') && c.idempotency_key) {
      const existing = d.prepare(`SELECT * FROM claims WHERE idempotency_key = ?`).get(c.idempotency_key);
      return { ok: false, idempotent_replay: true, existing };
    }
    throw err;
  }
}

export function getClaimByIdempotency(key) {
  const d = openDb();
  return d.prepare(`SELECT * FROM claims WHERE idempotency_key = ?`).get(key) || null;
}

export function markClaimVerified(claim_id, verified) {
  const d = openDb();
  d.prepare(`UPDATE claims SET verified = ? WHERE id = ?`).run(verified ? 1 : 0, claim_id);
}

export function listHistory(limit = 50) {
  const d = openDb();
  return d.prepare(`
    SELECT a.*, c.tx_hash AS winning_tx, c.claim_at_price_usd AS winning_price_usd, c.caller_id AS winner_caller
    FROM auctions a
    LEFT JOIN claims c ON c.auction_id = a.id AND c.winner = 1
    WHERE a.state IN ('claimed','expired')
    ORDER BY a.opened_at_ms DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, Number(limit) || 50)));
}

export function todayBook() {
  const d = openDb();
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const since_ms = startOfDay.getTime();
  const since = startOfDay.toISOString();

  const opens = d.prepare(`SELECT COUNT(*) AS n FROM auctions WHERE opened_at_ms >= ?`).get(since_ms)?.n || 0;
  const closes = d.prepare(`SELECT COUNT(*) AS n FROM auctions WHERE state = 'claimed' AND opened_at_ms >= ?`).get(since_ms)?.n || 0;
  const expired = d.prepare(`SELECT COUNT(*) AS n FROM auctions WHERE state = 'expired' AND opened_at_ms >= ?`).get(since_ms)?.n || 0;
  const claims = d.prepare(`
    SELECT a.asking_usd AS ask, c.claim_at_price_usd AS price
    FROM claims c JOIN auctions a ON a.id = c.auction_id
    WHERE c.winner = 1 AND c.ts >= ?
  `).all(since);

  let total_usdc = 0;
  let premium_sum = 0;
  let premium_n = 0;
  for (const r of claims) {
    if (Number.isFinite(r.price)) total_usdc += r.price;
    if (Number.isFinite(r.ask) && r.ask > 0 && Number.isFinite(r.price)) {
      premium_sum += (r.price - r.ask) / r.ask;
      premium_n += 1;
    }
  }
  const avg_premium_pct = premium_n > 0 ? premium_sum / premium_n : 0;

  return {
    window: 'today_utc',
    opens,
    closes,
    expired,
    avg_premium_pct: Number(avg_premium_pct.toFixed(4)),
    total_usdc: Number(total_usdc.toFixed(6)),
  };
}
