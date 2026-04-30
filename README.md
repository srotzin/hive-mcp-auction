# hive-mcp-auction

[![srotzin/hive-mcp-auction MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-auction/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-auction)

**Inbound reverse Dutch auction agent — Hive Civilization**

When a Hive shim hits its rate-limit headroom, the next request gets a 402 with a Dutch descent envelope: starting price 5x standard asking, dropping 5% every 30s until claimed or floor. First agent to settle at the current price wins the slot. Pure protocol — no DMs, no spam. Inbound only.

> Council provenance: Ad-hoc, user-promoted 2026-04-27 (Tier A position 2, symmetric sibling to HiveBarter). Barter discovers what others will sell for; auction discovers what others will pay for ours.

---

## What this is

`hive-mcp-auction` is a Model Context Protocol server that runs the inbound side of the 402 payment surface. When hivemorph's rate-limiter detects a shim's current usage exceeds its headroom (default 80% of cap), it signs an internal `auction_open` request, this service publishes the descent curve, and the next 402 envelope on that shim carries an `auction` block alongside the standard `accepts[]`. Agents who don't want to play pay normal asking and queue. Agents who want the slot now claim at the current curve price.

- **Protocol:** MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0
- **Transport:** `POST /mcp`
- **Discovery:** `GET /.well-known/mcp.json`
- **Health:** `GET /health`
- **Settlement:** USDC on Base L2 — real rails, no mock, no simulated
- **Brand gold:** Pantone 1245 C / `#C08D23`

## Tools

| Tool | Tier | Description |
|---|---|---|
| `auction_open` | internal | Open a new Dutch auction for a scarce shim slot. HMAC-signed, hivemorph rate-limiter only. Surfaced for discovery; opens go through `POST /v1/auction/open`. |
| `auction_subscribe` | 0 (free) | Subscribe to the live descent curve via SSE. Returns the subscribe URL. |
| `auction_book` | 0 (free) | Today aggregate: opens, closes, avg premium pct, total USDC captured. |

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auction/open` | Open a new Dutch auction (HMAC-signed; hivemorph only). |
| `GET` | `/v1/auction/current` | Current price for an open auction (deterministic). |
| `GET` | `/v1/auction/curve` | Full descent curve. JSON or SSE (`Accept: text/event-stream`). |
| `POST` | `/v1/auction/claim` | Claim at current price. First-claim-wins, race-safe. |
| `GET` | `/v1/auction/history` | Closed auction ledger. |
| `GET` | `/v1/auction/today` | Today aggregate (Tier 0, free). |
| `GET` | `/health` | Service health. |

## Dutch descent math

```
start_price = asking_usd * 5.0          (5x asking)
floor_price = asking_usd * 0.5          (50% of asking)
drop_pct    = 0.05                      (5% per tick)
interval_s  = 30                        (one tick per 30s)

current_price(t) = max(
  floor_price,
  start_price * (1 - drop_pct) ** floor((t - opened_at) / interval_s)
)
```

After ~28 ticks (~14 min) the auction reaches floor. If no claim by then, the auction expires and the slot returns to the standard 402 flow. **The function is pure.** Same arguments give the same number to the cent. No RNG, no DB read, no clock skew tolerance baked in. The public envelope alone is provably fair.

## 402 envelope extension

Standard hivemorph 402 envelope plus an `auction` block:

```json
{
  "x402_version": 1,
  "ask": "0.05",
  "accepts": [...],
  "auction": {
    "id": "auct_abc123",
    "type": "dutch",
    "asking_usd": "0.05",
    "current_price_usd": "0.2375",
    "start_price_usd": "0.25",
    "floor_price_usd": "0.025",
    "drop_pct": 0.05,
    "interval_s": 30,
    "opened_at": "2026-04-27T20:30:00Z",
    "expires_at": "2026-04-27T20:44:00Z",
    "claim_url": "https://hive-mcp-auction.onrender.com/v1/auction/claim",
    "subscribe_url": "https://hive-mcp-auction.onrender.com/v1/auction/curve?id=auct_abc123",
    "policy": "first-claim-wins"
  }
}
```

The standard `accepts[]` block stays. Agents who don't want to play pay normal asking and get queued. Auction is opt-in via `claim_url`.

## Claim flow (race-safe, first-claim-wins)

```
POST /v1/auction/claim
{
  "auction_id": "auct_abc123",
  "claim_at_price_usd": "0.2375",
  "idempotency_key": "{caller-uuid}",
  "tx_hash": "0x..."
}

→ 200 { winner: true, slot_token: "...", expires_in_s: 60 }
→ 409 { winner: false, reason: "already_claimed" }
→ 410 { winner: false, reason: "auction_expired" }
→ 422 { winner: false, reason: "price_mismatch", current_price_usd: "..." }
```

Race-safety is enforced by an atomic SQLite `UPDATE auctions SET state='claimed' WHERE id=? AND state='open'`. The first UPDATE that touches a row wins. Tx verification is async — `slot_token` is issued provisionally and the on-chain Transfer is verified against the wallet via Base RPC.

## Risk controls

| Cap | Value |
|---|---|
| Max simultaneous open auctions | 50 |
| Max descent below asking | 50% |
| Max start multiplier | 10x |
| Auction max duration | 14 min |
| Claim window after price-tick | 5s |
| Per-caller claim rate | 10/min |

All caps fail-closed. Configurable via env; missing or invalid env always falls back to the stricter default.

## Configuration

| Env | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `ENABLE_AUCTION` | no | `false` | Default-off. `/v1/auction/open` returns 503 unless `true`. Operator flips after the wallet is verified and HMAC key is set. |
| `WALLET_ADDRESS` | no | `0x15184…436e` | W1 MONROE on Base. |
| `USDC_BASE` | no | `0x833589…2913` | USDC contract on Base. |
| `BASE_RPC` | no | `https://mainnet.base.org` | |
| `AUCTION_OPEN_HMAC_KEY` | **yes (to open)** | — | Shared HMAC secret. Must match the value on hivemorph. **Never commit this.** Without it, every `/v1/auction/open` returns 401. |
| `MAX_CONCURRENT_AUCTIONS` | no | `50` | |
| `MAX_DESCENT_PCT` | no | `0.50` | |
| `MAX_START_MULT` | no | `10` | |
| `AUCTION_MAX_DURATION_S` | no | `840` | 14 minutes. |
| `AUCTION_INTERVAL_S` | no | `30` | One tick per 30s. |
| `AUCTION_DROP_PCT` | no | `0.05` | 5% per tick. |
| `PUBLIC_BASE_URL` | no | `https://hive-mcp-auction.onrender.com` | Used to build `claim_url` / `subscribe_url` in the envelope. |

## HMAC signing (for hivemorph)

Hivemorph signs each `/v1/auction/open` request:

```
ts   = Date.now().toString()
body = JSON.stringify(payload)
sig  = HMAC_SHA256(AUCTION_OPEN_HMAC_KEY, `${ts}.${body}`)

Headers:
  Content-Type: application/json
  X-Hive-Timestamp: ${ts}
  X-Hive-Signature: ${sig.hex}
```

Server rejects requests where `|now - ts| > 5min` or the signature does not match in constant time. Both shims must hold the same `AUCTION_OPEN_HMAC_KEY`.

## Run locally

```bash
git clone https://github.com/srotzin/hive-mcp-auction.git
cd hive-mcp-auction
npm install
npm start
# server up on http://localhost:3000/mcp
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/mcp.json
curl http://localhost:3000/v1/auction/today
```

## Connect from an MCP client

**Claude Desktop / Cursor / Manus** — add to your `mcp.json`:

```json
{
  "mcpServers": {
    "hive_mcp_auction": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://hive-mcp-auction.onrender.com/mcp"]
    }
  }
}
```

## Why Dutch (not Vickrey, not English)

- **Dutch (Shape α — this repo):** deterministic clock-driven price, first-claim-wins, no judgment, no late-bid manipulation, agents reveal urgency by claim timing.
- **Vickrey (Shape β):** requires trusted bid-window timing; late-bid attacks need defending; agents must trust we read sealed bids honestly.
- **English (Shape γ):** highest revenue per auction but blocks the slot for the full window even with one bidder. Works for unique assets, not fungible compute.

Dutch is the only one where the math is provably fair from the public envelope alone. Shapes β and γ are explicitly out of scope for v1; revisit once Shape α produces clean telemetry.

## Hive Civilization

Part of the [Hive Civilization](https://www.thehiveryiq.com) — sovereign DID, USDC settlement, agent-to-agent rails. Companion shims include `hive-mcp-barter` (the symmetric outbound sibling), `hive-mcp-evaluator`, `hive-mcp-compute-grid`, `hive-mcp-depin`, `hive-mcp-agent-storage`, `hive-mcp-agent-kyc`, and `hive-mcp-trade`.

## License

MIT (c) 2026 Steve Rotzin / Hive Civilization

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
