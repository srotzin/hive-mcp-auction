#!/usr/bin/env node
/**
 * hive-mcp-auction — Inbound reverse Dutch auction agent.
 *
 * Shape α only: clock-driven Dutch descent on scarce shim slots. When a
 * Hive shim hits its rate-limit headroom, hivemorph signs an internal
 * auction_open request; this service publishes the curve and accepts the
 * first valid claim at current price. Pure protocol — no DMs, no spam, no
 * outbound calls. Inbound only.
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec  : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Wallet: W1 MONROE 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e (Base L2).
 */

import express from 'express';
import crypto from 'node:crypto';
import {
  openAuction, getCurrent, getCurve, claim, sweepExpired, reportClaimVerification,
} from './lib/auctions.js';
import { openDb, listOpenAuctions, listHistory, todayBook } from './lib/ledger.js';
import { CAPS, pruneClaimWindow } from './lib/caps.js';
import { DUTCH } from './lib/dutch.js';
import { attachSubscriber, broadcastTick, notifyClaimed, subscriberCount } from './lib/sse.js';
import { verifyUsdcPayment } from './lib/verify.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const ENABLE_AUCTION = String(process.env.ENABLE_AUCTION || 'false').toLowerCase() === 'true';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_BASE = process.env.USDC_BASE || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const HMAC_KEY = process.env.AUCTION_OPEN_HMAC_KEY || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://hive-mcp-auction.onrender.com';

openDb();

// ─── HMAC auth on the privileged /v1/auction/open endpoint ────────────────
function verifyHmac(req) {
  if (!HMAC_KEY) return { ok: false, reason: 'hmac_key_unset' };
  const sig = String(req.headers['x-hive-signature'] || '');
  const ts = String(req.headers['x-hive-timestamp'] || '');
  if (!sig || !ts) return { ok: false, reason: 'missing_headers' };
  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > 5 * 60_000) return { ok: false, reason: 'stale_or_invalid_ts' };
  const body = JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', HMAC_KEY).update(`${ts}.${body}`).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'sig_length' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'sig_mismatch' };
  return { ok: true };
}

function buildEnvelope(auction) {
  if (!auction) return null;
  const opened_at_ms = new Date(auction.opened_at).getTime();
  const expires_at_ms = new Date(auction.expires_at).getTime();
  const cur = getCurrent(auction.id);
  return {
    id: auction.id,
    type: 'dutch',
    asking_usd: String(auction.asking_usd),
    current_price_usd: cur.ok ? String(cur.current_price_usd) : null,
    start_price_usd: String(auction.start_price_usd),
    floor_price_usd: String(auction.floor_price_usd),
    drop_pct: auction.drop_pct,
    interval_s: auction.interval_s,
    opened_at: auction.opened_at,
    expires_at: auction.expires_at,
    claim_url: `${PUBLIC_BASE_URL}/v1/auction/claim`,
    subscribe_url: `${PUBLIC_BASE_URL}/v1/auction/curve?id=${auction.id}`,
    policy: 'first-claim-wins',
    opened_at_ms,
    expires_at_ms,
  };
}

// ─── MCP tools ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'auction_open',
    description: 'Open a new Dutch auction for a scarce shim slot. INTERNAL — requires HMAC signature from hivemorph rate-limiter. Returns auction id, descent curve, and 402 envelope block.',
    inputSchema: {
      type: 'object',
      required: ['shim', 'asking_usd'],
      properties: {
        shim: { type: 'string', description: 'Origin shim id, e.g. "hive-mcp-evaluator".' },
        asking_usd: { type: 'number', description: 'Standard 402 asking price in USD. Curve is anchored on this.' },
        max_descent_pct: { type: 'number', description: 'Optional caller-bound on descent (capped at MAX_DESCENT_PCT).' },
      },
    },
  },
  {
    name: 'auction_subscribe',
    description: 'Subscribe to the live descent curve for an open auction. Returns the SSE URL — agents connect with EventSource for real-time price ticks. Tier 0, free, read-only.',
    inputSchema: {
      type: 'object',
      required: ['auction_id'],
      properties: {
        auction_id: { type: 'string', description: 'Auction id from /v1/auction/open.' },
      },
    },
  },
  {
    name: 'auction_book',
    description: 'Today aggregate: opens, closes, avg_premium_pct, total_usdc captured. Tier 0, free, read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case 'auction_open': {
      return {
        type: 'text',
        text: JSON.stringify({
          error: 'use_rest_with_hmac',
          detail: 'auction_open is privileged. Call POST /v1/auction/open with X-Hive-Signature and X-Hive-Timestamp headers. The MCP tool is exposed for discovery only.',
        }, null, 2),
      };
    }
    case 'auction_subscribe': {
      const id = String(args?.auction_id || '');
      if (!id) return { type: 'text', text: JSON.stringify({ error: 'auction_id required' }) };
      return {
        type: 'text',
        text: JSON.stringify({
          auction_id: id,
          subscribe_url: `${PUBLIC_BASE_URL}/v1/auction/curve?id=${id}`,
          transport: 'text/event-stream',
          events: ['open', 'tick', 'claimed', 'closed', 'error'],
          interval_s: DUTCH.INTERVAL_S,
        }, null, 2),
      };
    }
    case 'auction_book': {
      return { type: 'text', text: JSON.stringify(todayBook(), null, 2) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hive-mcp-auction', version: '1.0.0', description: 'Inbound reverse Dutch auction agent — Hive Civilization' },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {});
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── REST endpoints ───────────────────────────────────────────────────────

// HMAC-authenticated. Only hivemorph can open auctions.
app.post('/v1/auction/open', (req, res) => {
  if (!ENABLE_AUCTION) return res.status(503).json({ error: 'auction_disabled', detail: 'Set ENABLE_AUCTION=true to allow opens.' });
  const auth = verifyHmac(req);
  if (!auth.ok) return res.status(401).json({ error: 'unauthorized', reason: auth.reason });

  const { shim, asking_usd, max_descent_pct, meta } = req.body || {};
  const r = openAuction({
    shim,
    asking_usd: Number(asking_usd),
    max_descent_pct: Number.isFinite(Number(max_descent_pct)) ? Number(max_descent_pct) : undefined,
    created_by: 'hivemorph',
    meta,
  });
  if (!r.ok) return res.status(429).json({ error: r.error, reason: r.reason });

  const envelope = buildEnvelope(r.auction);
  res.json({
    auction: r.auction,
    curve: r.curve,
    envelope_402: envelope,
    auction_block: envelope,
  });
});

app.get('/v1/auction/current', (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  const r = getCurrent(id);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json(r);
});

app.get('/v1/auction/curve', (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('text/event-stream')) {
    return attachSubscriber(id, res);
  }
  const r = getCurve(id);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json(r);
});

app.post('/v1/auction/claim', async (req, res) => {
  const { auction_id, claim_at_price_usd, idempotency_key, tx_hash, caller_id } = req.body || {};
  if (!auction_id) return res.status(400).json({ error: 'auction_id required' });
  const result = claim({
    auction_id,
    claim_at_price_usd: Number(claim_at_price_usd),
    idempotency_key: idempotency_key || null,
    caller_id: caller_id || req.headers['x-caller-id'] || (req.ip ? `ip:${req.ip}` : null),
    tx_hash: tx_hash || null,
  });

  if (result.body?.winner) {
    notifyClaimed(auction_id, result.body.slot_token);
    if (tx_hash) {
      verifyUsdcPayment({
        tx_hash,
        expected_usd: result.body.claim_at_price_usd,
        expected_to: WALLET_ADDRESS,
      })
        .then(v => {
          if (result.body.claim_id) reportClaimVerification(result.body.claim_id, !!v.ok);
        })
        .catch(() => { /* best effort */ });
    }
  }
  return res.status(result.http).json(result.body);
});

app.get('/v1/auction/history', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  res.json({ history: listHistory(limit), limit });
});

app.get('/v1/auction/today', (req, res) => {
  res.json({
    tier: 0,
    free: true,
    wallet: WALLET_ADDRESS,
    enable_auction: ENABLE_AUCTION,
    open_auctions: listOpenAuctions().length,
    caps: CAPS,
    dutch: DUTCH,
    ...todayBook(),
  });
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'hive-mcp-auction',
  version: '1.0.0',
  enable_auction: ENABLE_AUCTION,
  wallet: WALLET_ADDRESS,
  usdc_base: USDC_BASE,
  base_rpc: BASE_RPC,
  caps: CAPS,
  dutch: DUTCH,
  open_auctions: listOpenAuctions().length,
}));

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hive-mcp-auction',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
}));

// ─── Root: HTML for browsers, JSON for agents ─────────────────────────────
const HTML_ROOT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>hive-mcp-auction — Inbound reverse Dutch auction agent</title>
<meta name="description" content="Inbound reverse Dutch auction agent. Clock-driven descent on scarce shim slots, first-claim-wins, USDC settlement on Base L2. MCP 2024-11-05.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --gold: #C08D23; --ink: #111; --paper: #fafaf7; --rule: #e7e3d6; }
  body { background: var(--paper); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 760px; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.55; font-size: 14.5px; }
  h1 { color: var(--gold); font-size: 1.6rem; letter-spacing: 0.01em; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gold); border-bottom: 1px solid var(--rule); padding-bottom: 0.35rem; margin-top: 2.2rem; }
  .lead { color: #444; margin: 0 0 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--gold); font-weight: 600; }
  code, pre { background: #f3f0e3; padding: 0.1rem 0.35rem; border-radius: 3px; }
  pre { padding: 0.75rem 0.9rem; overflow-x: auto; }
  a { color: var(--gold); text-decoration: none; border-bottom: 1px dotted var(--gold); }
  footer { margin-top: 3rem; color: #777; font-size: 12.5px; }
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "hive-mcp-auction",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "description": "Inbound reverse Dutch auction agent. Clock-driven descent on scarce shim slots, first-claim-wins, USDC settlement on Base L2.",
  "url": "https://hive-mcp-auction.onrender.com",
  "author": { "@type": "Person", "name": "Steve Rotzin", "url": "https://www.thehiveryiq.com" },
  "license": "https://opensource.org/licenses/MIT",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
</script>
</head>
<body>
<h1>hive-mcp-auction</h1>
<p class="lead">Inbound reverse Dutch auction agent. When a Hive shim hits its rate-limit headroom, the next request gets a 402 with a Dutch descent envelope: starting price 5x standard asking, dropping 5% every 30s until claimed or floor. First agent to settle at the current price wins the slot.</p>

<h2>Protocol</h2>
<table>
  <tr><th>MCP version</th><td>2024-11-05 / Streamable-HTTP / JSON-RPC 2.0</td></tr>
  <tr><th>Endpoint</th><td><code>POST /mcp</code></td></tr>
  <tr><th>Discovery</th><td><code>GET /.well-known/mcp.json</code></td></tr>
  <tr><th>Health</th><td><code>GET /health</code></td></tr>
  <tr><th>Settlement</th><td>USDC on Base L2 — real rails, no mock</td></tr>
</table>

<h2>Tools</h2>
<table>
  <tr><th>Name</th><th>Tier</th><th>Description</th></tr>
  <tr><td><code>auction_open</code></td><td>internal</td><td>Open a new Dutch auction. HMAC-only. Hivemorph rate-limiter signs.</td></tr>
  <tr><td><code>auction_subscribe</code></td><td>0</td><td>SSE stream of price ticks for an open auction.</td></tr>
  <tr><td><code>auction_book</code></td><td>0</td><td>Today: opens, closes, avg premium pct, total USDC.</td></tr>
</table>

<h2>REST endpoints</h2>
<table>
  <tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
  <tr><td>POST</td><td><code>/v1/auction/open</code></td><td>Open a new auction. HMAC-signed, hivemorph only.</td></tr>
  <tr><td>GET</td><td><code>/v1/auction/current</code></td><td>Current price for an open auction (deterministic).</td></tr>
  <tr><td>GET</td><td><code>/v1/auction/curve</code></td><td>Full descent curve. JSON or SSE (Accept: text/event-stream).</td></tr>
  <tr><td>POST</td><td><code>/v1/auction/claim</code></td><td>Claim at current price. First-claim-wins, race-safe.</td></tr>
  <tr><td>GET</td><td><code>/v1/auction/history</code></td><td>Closed auction ledger.</td></tr>
  <tr><td>GET</td><td><code>/v1/auction/today</code></td><td>Today aggregate (Tier 0, free).</td></tr>
  <tr><td>GET</td><td><code>/health</code></td><td>Service health.</td></tr>
</table>

<h2>Dutch descent math</h2>
<pre>start_price = asking_usd * 5.0          (5x asking)
floor_price = asking_usd * 0.5          (50% of asking)
drop_pct    = 0.05                      (5% per tick)
interval_s  = 30                        (one tick per 30s)

current_price(t) = max(
  floor_price,
  start_price * (1 - drop_pct) ** floor((t - opened_at) / interval_s)
)</pre>
<p class="lead">After ~28 ticks (~14 min) the auction reaches floor. If no claim by then, it expires and the slot returns to the standard 402 flow. The function is pure — same arguments give the same number to the cent. The public envelope alone is provably fair.</p>

<h2>Risk controls</h2>
<table>
  <tr><th>Cap</th><th>Value</th></tr>
  <tr><td>Max simultaneous open auctions</td><td>50</td></tr>
  <tr><td>Max descent below asking</td><td>50%</td></tr>
  <tr><td>Max start multiplier</td><td>10x</td></tr>
  <tr><td>Auction max duration</td><td>14 min</td></tr>
  <tr><td>Claim window after price-tick</td><td>5s</td></tr>
  <tr><td>Per-caller claim rate</td><td>10/min</td></tr>
</table>

<footer>
  <p>Hive Civilization · Pantone 1245 C / #C08D23 · MIT · <a href="https://github.com/srotzin/hive-mcp-auction">github.com/srotzin/hive-mcp-auction</a></p>
</footer>
</body></html>`;

app.get('/', (req, res) => {
  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return res.json({
      name: 'hive-mcp-auction',
      version: '1.0.0',
      description: 'Inbound reverse Dutch auction agent. Clock-driven descent on scarce shim slots, first-claim-wins, USDC settlement on Base L2.',
      endpoint: '/mcp',
      transport: 'streamable-http',
      protocol: '2024-11-05',
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      enable_auction: ENABLE_AUCTION,
      caps: CAPS,
      dutch: DUTCH,
    });
  }
  res.set('content-type', 'text/html; charset=utf-8').send(HTML_ROOT);
});

// ─── Background sweepers ──────────────────────────────────────────────────
function tickAllOpen() {
  try {
    const open = listOpenAuctions();
    for (const a of open) broadcastTick(a.id);
  } catch (e) {
    console.error('tickAllOpen error:', e?.message || e);
  }
}

function expireSweep() {
  try {
    const n = sweepExpired();
    if (n > 0) console.log(`expired ${n} auction(s)`);
    pruneClaimWindow();
  } catch (e) {
    console.error('expireSweep error:', e?.message || e);
  }
}

setInterval(tickAllOpen, DUTCH.INTERVAL_S * 1000);
setInterval(expireSweep, 60_000);

app.listen(PORT, () => {
  console.log(`hive-mcp-auction on :${PORT}`);
  console.log(`  enable_auction : ${ENABLE_AUCTION}`);
  console.log(`  wallet         : ${WALLET_ADDRESS}`);
  console.log(`  usdc_base      : ${USDC_BASE}`);
  console.log(`  base_rpc       : ${BASE_RPC}`);
  console.log(`  hmac_configured: ${!!HMAC_KEY}`);
  console.log(`  dutch          : start=${DUTCH.START_MULT}x floor=${DUTCH.FLOOR_PCT*100}% drop=${DUTCH.DROP_PCT*100}%/${DUTCH.INTERVAL_S}s max=${DUTCH.MAX_DURATION_S}s`);
});
