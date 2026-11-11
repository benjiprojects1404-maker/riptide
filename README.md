# Riptide

A read-only, minute-by-minute monitor of DEX price gaps on any EVM chain with Uniswap v3 (and optionally v4) pools.

Every minute it asks the chain's Uniswap quoters what a $10 and a $1,000 trade would really return, compares that with
Binance or Coinbase (or, for tokens with no exchange listing, with another pool on the same chain), subtracts the
exchange fee and live gas, and logs every gap to a Cloudflare D1 database. A rug alarm reads every watched pool each
minute and pauses a pair when its price collapses or its liquidity is pulled. A dashboard and a self-writing weekly
report sit on top.

**Paper trading only.** No wallet, no keys, no exchange accounts, no orders. It only reads public prices.

Live instance (Circle's Arc mainnet): https://benjiprojects1404-services.pages.dev/riptide/ ·
weekly report: https://benjiprojects1404-services.pages.dev/riptide/weekly/

The config shipped here is that live Arc setup, so it works as soon as it's deployed. Change `worker/src/config.js`
to point it at another chain.

## What's in it

```
worker/                Cloudflare Worker (cron every minute + JSON API)
  src/config.js        everything chain-specific: chain, RPC, Uniswap contracts, pairs, watch list
  src/index.js         sampling, cost maths, storage, API
  src/rug.js           rug alarm (price drop / liquidity pulled, pair paused)
  src/faze.js          Faze launchpad watch (Arc only; off when config sets FAZE to null)
  scripts/check-pool.js  checks a Uniswap v4 pool before you add it
  schema.sql, wrangler.toml
dashboard/             static pages: live dashboard and weekly report (host anywhere: Pages, GitHub Pages, Netlify)
```

## Deploy (about 10 minutes, Cloudflare free tier)

You need Node 18+ and a free Cloudflare account. From `worker/`:

```bash
npx wrangler login                       # opens Cloudflare in your browser
npx wrangler d1 create riptide           # prints a database_id
```

Paste that `database_id` into `wrangler.toml`, then:

```bash
npx wrangler d1 execute riptide --remote --file=schema.sql
npx wrangler deploy
```

`deploy` prints the Worker's address, e.g. `https://riptide.<your-subdomain>.workers.dev`.
Open `<that address>/api/latest` after a minute or two: you should see a row per pair and size.

Dashboard: open `dashboard/index.html?api=<your Worker address>` (the weekly page takes the same `?api=`), or set
`DEFAULT_API` in `dashboard/index.html` and the address in `dashboard/weekly/index.html`, then host the folder anywhere.

Free tier is enough: roughly 10,000–15,000 rows a day with the shipped pairs, 30 days kept.

### Updating a Riptide that's already running

Deploying with the same Worker name (`riptide`) and the same D1 database replaces the code and keeps the data and
any secrets. Look up the database ID with `npx wrangler d1 list`, put it in `wrangler.toml`, then `npx wrangler deploy`.
The schema upgrades itself on the first run.

### A private RPC (optional)

Cloudflare's servers are shared, so public RPCs sometimes rate-limit them. Give the Worker its own endpoint
(a free Alchemy / dRPC / QuickNode app):

```bash
npx wrangler secret put RPC_URL          # stored encrypted in Cloudflare; never commit it
```

The public RPC in `config.js` stays as the fallback. (`ARC_RPC_URL` from older deployments still works.)

## Pointing it at another chain

Edit `worker/src/config.js` only:

1. `CHAIN`: name, `chainId` (every RPC is checked against it), public `rpc`, `nativeDecimals`, and `nativeUsd`:
   a number if gas is paid in a dollar token, or a Coinbase product such as `"ETH-USD"` to price gas live.
2. `USDC` / `USDC_DEC`: the stablecoin pairs are quoted against.
3. `QUOTER` (Uniswap v3 QuoterV2), and if the chain has v4, `QUOTER_V4` and `STATE_VIEW`. Take these from
   Uniswap's deployment docs and check them on the chain's explorer.
4. `PAIRS`: tokens to compare with an exchange (`ref`, `sym`, `cexFee`, v3 `poolFee`).
5. `VENUE_PAIRS`: tokens with no exchange listing, compared pool against pool (set to `[]` if none).
6. `WATCH`: pools for the rug alarm (v3 by pool address, v4 by pool id).
7. `FAZE`: set to `null` anywhere but Arc. The dashboard hides the launchpad sections automatically.
8. `GAS_UNITS`: a typical swap's gas on that chain.

Before adding a v4 pool, check it:

```bash
cd worker
RPC=https://... STATE_VIEW=0x... USDC=0x... node scripts/check-pool.js <token address> <v4 pool id>
```

It prints the token, the pool's liquidity and the price for each possible quote currency, so you can see which is right.

The database keeps its original column names (`arc_buy`, `arc_sell`) whatever the chain; they mean "price on the chain".

## API

- `/api/latest` latest check for every pair and size, plus the chain name and whether Faze is on
- `/api/summary?days=7` totals per pair and size
- `/api/series?days=7&size=1000` 15-minute averages for the chart
- `/api/opps?days=7` checks where the gap beat all costs
- `/api/events?days=7` rug-alarm events
- `/api/faze?days=7` watched coins (price, 24 h change), plus Faze launches and graduations when enabled
- `/api/csv?days=7` everything, as CSV

## What it does and doesn't count

- DEX prices are real quotes, so they include the pool fee and slippage at that size.
- Costs subtracted: the exchange taker fee (assumed per pair; your tier may be lower) and gas at the live price.
- Not counted: moving funds between the chain and an exchange (withdrawal and bridge fees, transfer time). A
  "would trade" is an upper bound, not a promise.
- During a rug-alarm pause, a pair can't count as "would trade": a huge gap during a rug is a trap, not an opportunity.

Not financial advice. Nothing here trades or signs anything.

## Stop it

`npx wrangler delete riptide` removes the Worker; `npx wrangler d1 delete riptide` removes the data.

## Need it set up or extended?

Riptide is built by [Undercurrent Works](https://benjiprojects1404-services.pages.dev/): smart contracts, dApps and
on-chain monitoring. Telegram: [@undercurrentworks](https://t.me/undercurrentworks).

## Licence

MIT. See [LICENSE](LICENSE). Arc is a trademark of Circle Internet Group, Inc.; this project is independent and not
made or endorsed by Circle.
