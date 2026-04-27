# hive-mcp-auction v1.0.0

First public release. Inbound reverse Dutch auction agent on the Hive Civilization rails.

## Council provenance

Ad-hoc, user-promoted 2026-04-27 as the symmetric sibling to HiveBarter (Tier A position 2). Barter discovers what others will sell for; auction discovers what others will pay for ours. When a Hive shim hits its rate-limit headroom, every congestion event becomes a revenue event instead of a 429.

## What this is

Shape α only — clock-driven Dutch descent on scarce shim slots. Starting price 5x standard asking, dropping 5% every 30s until claimed at the current curve price or expired at 14 min floor. First agent to settle wins. Pure protocol, inbound only, no DMs, no spam, no outbound calls.

Shapes β (sealed-bid Vickrey) and γ (English ascending) are explicitly out of scope for v1. Revisit once Shape α produces clean telemetry.

## Tools (3)

| Tool | Tier | Description |
|---|---|---|
| `auction_open` | internal | Open a new Dutch auction. HMAC-signed, hivemorph rate-limiter only. |
| `auction_subscribe` | 0 (free) | Subscribe to the live descent curve via SSE. |
| `auction_book` | 0 (free) | Today aggregate: opens, closes, avg premium pct, total USDC. |

## REST endpoints (7)

`POST /v1/auction/open` · `GET /v1/auction/current` · `GET /v1/auction/curve` (JSON or SSE) · `POST /v1/auction/claim` · `GET /v1/auction/history` · `GET /v1/auction/today` · `GET /health`

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

The function is pure. Same arguments give the same number to the cent. No RNG, no DB read, no clock skew tolerance baked in. The public envelope alone is provably fair — that is the brand fit.

After ~28 ticks (~14 min) the auction reaches floor. If no claim by then, it expires and the slot returns to the standard 402 flow.

## 402 envelope extension

Standard hivemorph 402 envelope plus an `auction` block alongside `accepts[]`. Agents who don't want to play pay normal asking and queue. Auction is opt-in via the `claim_url`. Deterministic curve in JSON; live SSE stream at `subscribe_url`.

## Race-safe claim

First-claim-wins enforced by an atomic SQLite `UPDATE auctions SET state='claimed' WHERE id=? AND state='open'`. The first UPDATE that touches a row wins. `slot_token` is issued provisionally; on-chain Transfer verification runs async against Base RPC and revokes the slot on tx fail.

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

## Defaults

`ENABLE_AUCTION=false`. The `/v1/auction/open` endpoint returns 503 until the operator flips it on. Operators flip it to `true` after setting `AUCTION_OPEN_HMAC_KEY` and confirming the wallet is funded.

## HMAC

`/v1/auction/open` is privileged. Hivemorph signs each request with HMAC-SHA256 over `${ts}.${body}` using a shared `AUCTION_OPEN_HMAC_KEY` and the server rejects clock skew > 5 min and any sig mismatch in constant time. Both services must hold the same key.

## Wallet

W1 MONROE `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` on Base L2. The repo never carries a private key — auction is 100% inbound, so there is no outbound spend cap and no signing wallet on this service. Verification is read-only against the Base RPC.

## Backend

Self-contained. SQLite ledger at `/tmp/auction.db` (4 tables: `auctions`, `claims`, `descents`, `expires`). `/tmp` survives Render restart for the lifetime of the instance; daily rollups go to hivemorph at midnight ET.

## Brand

Pantone 1245 C / `#C08D23`. Stripe Docs / Bloomberg Terminal voice. No exclamation points, no emojis, no superlatives.
