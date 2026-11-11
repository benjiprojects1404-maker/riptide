// Riptide: a read-only monitor of price gaps between an EVM chain's Uniswap pools and centralised exchanges.
// Chain, contracts, pairs and the watch list are all in config.js; the shipped values are Arc mainnet (chain 5042).
// PAPER TRADING ONLY. No wallet, no keys, no accounts, no orders. It only reads public prices.
//
// Every minute (cron) it:
//   1. asks Arc's Uniswap v3 QuoterV2 what a $10 and a $1,000 trade would return, both directions;
//   2. reads the live bid/ask on the reference exchange (Binance or Coinbase);
//   3. works out the gap both ways, minus the exchange fee and Arc gas, and stores it in D1.
// For volatile Arc-native tokens with no exchange listing (ARGUS, FAZE) it instead compares two Arc pools
// by chaining real quotes: buy in one pool, sell the same tokens in the other.
// It also follows Faze (faze.fun), Arc's memecoin launchpad: new launches, graduations into locked Uniswap v4 pools,
// and a week of rug-alarm checks on each newly graduated pool (see faze.js).
// The same Worker serves a small JSON API for the dashboard.

import { ensureSchema, checkPools, pausedPairs, WATCH, PAUSE_MIN, PRICE_DROP, LIQ_DROP } from "./rug.js";
import { ensureFazeSchema, scanFaze, graduatedWatch } from "./faze.js";
import { CHAIN, NATIVE, USDC, USDC_DEC, QUOTER, QUOTER_V4, SIZES, GAS_UNITS, COINBASE_FEE, RETENTION_DAYS, PAIRS, VENUE_PAIRS, FAZE } from "./config.js";

export { PAIRS, VENUE_PAIRS };
// Pairs that are logged and shown but can never count as a trade (see watchOnly in config.js).
export const WATCH_ONLY = new Set(VENUE_PAIRS.filter(p => p.watchOnly).map(p => p.id));
const QUOTE_SELECTOR = "0xc6a5026a"; // quoteExactInputSingle((address,address,uint256,uint24,uint160))
const V4_SELECTOR = "0xaa9d21cb"; // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
const TAG = CHAIN.name.toLowerCase() + ": "; // prefix for chain errors in the stored rows
// RPC_URL (optional secret) is tried before the public RPC. ARC_RPC_URL is still read, for older deployments.
const endpointsOf = env => [env.RPC_URL, env.ARC_RPC_URL, CHAIN.rpc].filter(Boolean);

const word = v => BigInt(v).toString(16).padStart(64, "0");
const addrWord = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// v4 pool key: currency0 is the lower address. buy = quote currency in, token out.
function quoteV4Call(token, pool, buy, amountIn) {
  const quoteIsC0 = pool.quote.toLowerCase() < token.toLowerCase();
  const [c0, c1] = quoteIsC0 ? [pool.quote, token] : [token, pool.quote];
  const zeroForOne = buy ? quoteIsC0 : !quoteIsC0;
  return V4_SELECTOR + word(32) + addrWord(c0) + addrWord(c1) + word(pool.fee) + word(pool.tickSpacing) + addrWord(pool.hooks)
    + word(zeroForOne ? 1 : 0) + word(amountIn) + word(256) + word(0);
}
const firstWord = r => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n);

function quoteCall(tokenIn, tokenOut, amountIn, fee) {
  return QUOTE_SELECTOR + addrWord(tokenIn) + addrWord(tokenOut) + word(amountIn) + word(fee) + word(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sends the calls as one JSON-RPC batch. Calls that fail (often "rate limit" on shared Cloudflare IPs) are
// retried a few times, then on the next endpoint. Returns results by index plus the last error seen.
export async function rpcBatch(calls, endpoints) {
  const out = new Array(calls.length).fill(null);
  let todo = calls.map((_, i) => i), lastErr = null;
  for (const url of endpoints) {
    // Make sure the endpoint really is the configured chain before trusting its answers.
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }) });
      const j = await r.json();
      if (j.result && parseInt(j.result, 16) !== CHAIN.chainId) { lastErr = `endpoint is chain ${parseInt(j.result, 16)}, not ${CHAIN.name} (${CHAIN.chainId})`; continue; }
    } catch (_) { /* let the main call report the problem */ }
    for (let attempt = 0; attempt < 3 && todo.length; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        const body = todo.map(i => ({ jsonrpc: "2.0", id: i, method: calls[i].method, params: calls[i].params }));
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) { lastErr = "http " + r.status; continue; }
        const res = await r.json();
        for (const x of Array.isArray(res) ? res : [res]) {
          if (x.error) lastErr = (x.error.code ? x.error.code + " " : "") + (x.error.message || "error");
          else if (x.id != null && x.result && x.result !== "0x") out[x.id] = x.result;
          else if (x.id != null) lastErr = "empty result (no contract at that address on this network?)";
        }
      } catch (e) { lastErr = String(e.message || e); }
      todo = todo.filter(i => out[i] == null);
    }
    if (!todo.length) break;
  }
  return { out, lastErr: todo.length ? lastErr : null };
}

async function refPrice(p) {
  const coinbase = async sym => {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1000 * attempt);
      r = await fetch(`https://api.exchange.coinbase.com/products/${sym}/ticker`, { headers: { "user-agent": "riptide-monitor" } });
      if (r.status !== 429) break;   // shared Cloudflare IPs sometimes get "too many requests"
    }
    if (!r.ok) throw new Error("coinbase " + r.status);
    const j = await r.json();
    return { bid: Number(j.bid), ask: Number(j.ask), src: "coinbase", fee: COINBASE_FEE };
  };
  if (p.ref === "coinbase") return coinbase(p.sym);
  // Binance blocks some server regions; fall back to its public market-data mirror.
  for (const host of ["https://api.binance.com", "https://data-api.binance.vision"]) {
    try {
      const r = await fetch(`${host}/api/v3/ticker/bookTicker?symbol=${p.sym}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.bidPrice) return { bid: Number(j.bidPrice), ask: Number(j.askPrice), src: host.includes("vision") ? "binance-mirror" : "binance", fee: p.cexFee };
    } catch (_) { /* try next host */ }
  }
  if (p.cb) return coinbase(p.cb);
  throw new Error("binance unavailable");
}

const units = (n, dec) => BigInt(Math.round(n * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12));
const fromUnits = (v, dec) => Number(v) / 10 ** dec;

// USD price of the gas token: fixed in config, or read from Coinbase once per run.
async function nativeUsd() {
  if (typeof CHAIN.nativeUsd === "number") return CHAIN.nativeUsd;
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${CHAIN.nativeUsd}/ticker`, { headers: { "user-agent": "riptide-monitor" } });
    const j = await r.json();
    return (Number(j.bid) + Number(j.ask)) / 2 || 0;
  } catch (_) { return 0; }
}

export async function sample(env = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const refs = [];
  for (const p of PAIRS) { refs.push(await refPrice(p).catch(e => ({ error: String(e.message || e) }))); await sleep(250); }

  // One JSON-RPC batch for every quote plus the gas price.
  const calls = [{ method: "eth_gasPrice", params: [] }];
  const plan = [];
  PAIRS.forEach((p, i) => {
    const ref = refs[i]; if (ref.error) return;
    const mid = (ref.bid + ref.ask) / 2;
    for (const usd of SIZES) {
      plan.push({ i, usd, dir: "buy", idx: calls.length });   // USDC -> token on Arc
      calls.push({ method: "eth_call", params: [{ to: QUOTER, data: quoteCall(USDC, p.token, units(usd, USDC_DEC), p.poolFee) }, "latest"] });
      plan.push({ i, usd, dir: "sell", idx: calls.length, tokIn: usd / mid }); // token -> USDC on Arc
      calls.push({ method: "eth_call", params: [{ to: QUOTER, data: quoteCall(p.token, USDC, units(usd / mid, p.dec), p.poolFee) }, "latest"] });
    }
  });
  // If the chain can't be reached, still log the minute with the reason instead of saving nothing.
  const endpoints = endpointsOf(env);
  const { out: res, lastErr } = await rpcBatch(calls, endpoints);
  const arcError = lastErr ? TAG + lastErr.slice(0, 120) : null;
  const gasPrice = res[0] ? BigInt(res[0]) : 20000000000n;
  const gasUsd = Number(GAS_UNITS * gasPrice) / 10 ** CHAIN.nativeDecimals * await nativeUsd();

  const rows = [];
  for (const [i, p] of PAIRS.entries()) {
    const ref = refs[i];
    for (const usd of SIZES) {
      const row = { ts, pair: p.id, size: usd, ref_src: ref.src || null, cex_bid: ref.bid ?? null, cex_ask: ref.ask ?? null,
        arc_buy: null, arc_sell: null, gross_a: null, gross_b: null, net_a: null, net_b: null, net_best: null, would_trade: 0,
        cex_fee: ref.fee ?? p.cexFee, gas_usd: gasUsd, error: ref.error || null };
      if (!row.error) {
        const b = plan.find(x => x.i === i && x.usd === usd && x.dir === "buy");
        const s = plan.find(x => x.i === i && x.usd === usd && x.dir === "sell");
        const outTok = res[b.idx] && res[b.idx].length >= 66 ? fromUnits(BigInt(res[b.idx].slice(0, 66)), p.dec) : 0;
        const outUsd = res[s.idx] && res[s.idx].length >= 66 ? fromUnits(BigInt(res[s.idx].slice(0, 66)), USDC_DEC) : 0;
        if (outTok > 0) row.arc_buy = usd / outTok;          // USDC per token paid on Arc (includes pool fee and slippage)
        if (outUsd > 0) row.arc_sell = outUsd / s.tokIn;     // USDC per token received on Arc
        const costs = (ref.fee ?? p.cexFee) + gasUsd / usd;
        if (row.arc_buy) { row.gross_a = ref.bid / row.arc_buy - 1; row.net_a = row.gross_a - costs; }   // buy Arc, sell exchange
        if (row.arc_sell) { row.gross_b = row.arc_sell / ref.ask - 1; row.net_b = row.gross_b - costs; } // buy exchange, sell Arc
        const nets = [row.net_a, row.net_b].filter(v => v !== null);
        if (nets.length) { row.net_best = Math.max(...nets); row.would_trade = row.net_best > 0 ? 1 : 0; }
        if (!row.arc_buy && !row.arc_sell) row.error = arcError || "no " + CHAIN.name.toLowerCase() + " quote";
      }
      rows.push(row);
    }
  }
  rows.push(...await sampleVenues(ts, gasUsd, endpoints).catch(e => VENUE_PAIRS.flatMap(p => SIZES.map(usd => ({ ts, pair: p.id, size: usd,
    ref_src: null, cex_bid: null, cex_ask: null, arc_buy: null, arc_sell: null, gross_a: null, gross_b: null, net_a: null, net_b: null,
    net_best: null, would_trade: 0, cex_fee: 0, gas_usd: null, error: TAG + String(e.message || e).slice(0, 120) })))));
  return rows;
}

// One quote in one venue: buy = USD in, token out; sell = token in, USD out. Returns the call, and the
// decimals of the USD side so results can be read in dollars.
function venueCall(p, v, buy, amountIn) {
  if (v.kind === "v3") return { to: QUOTER, data: buy ? quoteCall(USDC, p.token, amountIn, v.fee) : quoteCall(p.token, USDC, amountIn, v.fee), qdec: USDC_DEC };
  return { to: QUOTER_V4, data: quoteV4Call(p.token, v, buy, amountIn), qdec: v.qdec };
}
const qdecOf = v => (v.kind === "v3" ? USDC_DEC : v.qdec);

// Buy on one Arc venue, sell the same tokens on the other: two rounds of quotes (the second leg needs the
// first leg's output). Both legs settle on Arc, so there is no exchange fee and no transfer; only two swaps' gas.
async function sampleVenues(ts, gasUsd, endpoints) {
  const rows = [];
  for (const p of VENUE_PAIRS) {
    const call = c => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] });
    const r1 = [], plan1 = [];
    for (const usd of SIZES) {
      plan1.push({ usd, leg: "homebuy", idx: r1.length });
      r1.push(call(venueCall(p, p.home, true, units(usd, qdecOf(p.home)))));
      p.others.forEach((v, k) => { plan1.push({ usd, leg: "otherbuy", k, idx: r1.length });
        r1.push(call(venueCall(p, v, true, units(usd, qdecOf(v))))); });
    }
    const a = await rpcBatch(r1, endpoints);
    const got = (usd, leg, k) => firstWord(a.out[plan1.find(x => x.usd === usd && x.leg === leg && x.k === k).idx]);
    const r2 = [], plan2 = [];
    for (const usd of SIZES) {
      const homeTok = got(usd, "homebuy", undefined);
      p.others.forEach((v, k) => {
        const otherTok = got(usd, "otherbuy", k);
        if (homeTok > 0n) { plan2.push({ usd, k, leg: "sellOther", idx: r2.length }); r2.push(call(venueCall(p, v, false, homeTok))); }
        if (otherTok > 0n) { plan2.push({ usd, k, leg: "sellHome", idx: r2.length }); r2.push(call(venueCall(p, p.home, false, otherTok))); }
      });
    }
    const b = r2.length ? await rpcBatch(r2, endpoints) : { out: [], lastErr: null };
    const err = a.lastErr || b.lastErr;
    for (const usd of SIZES) {
      const costs = 2 * gasUsd / usd; // two swaps on Arc; pool fees and slippage are already inside the quotes
      let best = null;
      p.others.forEach((v, k) => {
        const homeTok = got(usd, "homebuy", undefined), otherTok = got(usd, "otherbuy", k);
        const sA = plan2.find(x => x.usd === usd && x.k === k && x.leg === "sellOther");
        const sB = plan2.find(x => x.usd === usd && x.k === k && x.leg === "sellHome");
        const outA = sA ? fromUnits(firstWord(b.out[sA.idx]), qdecOf(v)) : 0;      // buy home, sell other
        const outB = sB ? fromUnits(firstWord(b.out[sB.idx]), qdecOf(p.home)) : 0; // buy other, sell home
        const row = { ts, pair: p.id, size: usd, ref_src: CHAIN.name.toLowerCase() + " " + v.label,
          arc_buy: homeTok > 0n ? usd / fromUnits(homeTok, p.dec) : null,
          arc_sell: outB && otherTok > 0n ? outB / fromUnits(otherTok, p.dec) : null,
          cex_ask: otherTok > 0n ? usd / fromUnits(otherTok, p.dec) : null,
          cex_bid: outA && homeTok > 0n ? outA / fromUnits(homeTok, p.dec) : null,
          gross_a: outA ? outA / usd - 1 : null, gross_b: outB ? outB / usd - 1 : null,
          net_a: null, net_b: null, net_best: null, would_trade: 0, cex_fee: 0, gas_usd: 2 * gasUsd, error: null };
        if (row.gross_a !== null) row.net_a = row.gross_a - costs;
        if (row.gross_b !== null) row.net_b = row.gross_b - costs;
        const nets = [row.net_a, row.net_b].filter(v => v !== null);
        if (nets.length) { row.net_best = Math.max(...nets); row.would_trade = row.net_best > 0 ? 1 : 0; }
        if (row.net_best !== null && (!best || row.net_best > best.net_best)) best = row;
      });
      rows.push(best || { ts, pair: p.id, size: usd, ref_src: null, cex_bid: null, cex_ask: null, arc_buy: null, arc_sell: null,
        gross_a: null, gross_b: null, net_a: null, net_b: null, net_best: null, would_trade: 0, cex_fee: 0, gas_usd: 2 * gasUsd,
        error: err ? TAG + err.slice(0, 120) : "no " + CHAIN.name.toLowerCase() + " quote" });
    }
  }
  return rows;
}

const COLS = ["ts", "pair", "size", "ref_src", "cex_bid", "cex_ask", "arc_buy", "arc_sell", "gross_a", "gross_b", "net_a", "net_b", "net_best", "would_trade", "cex_fee", "gas_usd", "error", "alert"];

const BUCKET = 900; // 15-minute rollup buckets

// Keeps D1 reads low: the dashboard reads small 15-minute rollups and a short table of hits
// instead of scanning every saved minute (D1 counts every row a query scans).
const ROLLUP_UPSERT = `INSERT INTO rollup (bucket, pair, size, n, hits, sum_best_gross, max_net, paper_pnl, first_ts, last_ts,
    sum_ga, n_ga, sum_gb, n_gb, sum_nb, n_nb) VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (bucket, pair, size) DO UPDATE SET n = n + 1, hits = hits + excluded.hits,
    sum_best_gross = sum_best_gross + excluded.sum_best_gross,
    max_net = CASE WHEN excluded.max_net IS NULL THEN max_net WHEN max_net IS NULL OR excluded.max_net > max_net THEN excluded.max_net ELSE max_net END,
    paper_pnl = paper_pnl + excluded.paper_pnl, first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts),
    sum_ga = sum_ga + excluded.sum_ga, n_ga = n_ga + excluded.n_ga, sum_gb = sum_gb + excluded.sum_gb, n_gb = n_gb + excluded.n_gb,
    sum_nb = sum_nb + excluded.sum_nb, n_nb = n_nb + excluded.n_nb`;

async function store(env, rows) {
  const stmt = env.DB.prepare(`INSERT INTO samples (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
  const opp = env.DB.prepare(`INSERT INTO opps (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
  const roll = env.DB.prepare(ROLLUP_UPSERT);
  const v = x => (x === null || x === undefined ? 0 : x), has = x => (x === null || x === undefined ? 0 : 1);
  const stmts = rows.map(r => stmt.bind(...COLS.map(c => r[c])));
  for (const r of rows) {
    if (r.would_trade) stmts.push(opp.bind(...COLS.map(c => r[c])));
    if (r.error) continue; // the dashboard's summary and chart only count clean samples
    stmts.push(roll.bind(Math.floor(r.ts / BUCKET) * BUCKET, r.pair, r.size, r.would_trade ? 1 : 0,
      Math.max(r.gross_a ?? -1, r.gross_b ?? -1), r.net_best ?? null, r.would_trade ? v(r.net_best) * r.size : 0, r.ts, r.ts,
      v(r.gross_a), has(r.gross_a), v(r.gross_b), has(r.gross_b), v(r.net_best), has(r.net_best)));
  }
  await env.DB.batch(stmts);
}

// Small per-isolate cache so several open dashboards share one set of reads.
const memo = new Map();
async function cached(key, ttlSec, fn) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  memo.set(key, { value, until: Date.now() + ttlSec * 1000 });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return value;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "cache-control": "public, max-age=30" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS } });

async function api(url, env) {
  const p = url.pathname;
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  if (p === "/api/latest") {
    const r = await cached("latest", 30, () => env.DB.prepare(`SELECT * FROM samples WHERE ts = (SELECT MAX(ts) FROM samples) ORDER BY pair, size`).all());
    return json({ rows: r.results, pairs: PAIRS.map(({ id, ref, sym, cexFee, poolFee }) => ({ id, ref, sym, cexFee, poolFee })), watchOnly: [...WATCH_ONLY],
      rugAlarm: { priceDrop: PRICE_DROP, liquidityDrop: LIQ_DROP, pauseMinutes: PAUSE_MIN },
      chain: { name: CHAIN.name, chainId: CHAIN.chainId, explorer: CHAIN.explorer || null }, faze: !!FAZE });
  }
  const fromBucket = Math.floor(since / BUCKET) * BUCKET;
  if (p === "/api/summary") {
    return json(await cached(`summary:${days}`, 300, async () => {
      const r = await env.DB.prepare(`SELECT pair, size, SUM(n) n, SUM(hits) hits, MAX(max_net) best_net,
          SUM(sum_best_gross) / SUM(n) avg_best_gross, MIN(first_ts) first_ts, MAX(last_ts) last_ts, SUM(paper_pnl) paper_pnl
        FROM rollup WHERE bucket >= ? GROUP BY pair, size ORDER BY pair, size`).bind(fromBucket).all();
      const start = await env.DB.prepare(`SELECT MIN(ts) t FROM samples`).first();
      return { days, since, started: start ? start.t : null, rows: r.results };
    }));
  }
  if (p === "/api/series") {
    // One point per 15 minutes (average) so a week is ~670 points per line.
    const size = Number(url.searchParams.get("size")) || 1000;
    return json(await cached(`series:${days}:${size}`, 300, async () => {
      const r = await env.DB.prepare(`SELECT pair, bucket t, sum_ga / n_ga ga, sum_gb / n_gb gb, sum_nb / n_nb nb
        FROM rollup WHERE bucket >= ? AND size = ? ORDER BY bucket`).bind(fromBucket, size).all();
      return { size, rows: r.results };
    }));
  }
  if (p === "/api/opps") {
    return json(await cached(`opps:${days}`, 120, async () => {
      const r = await env.DB.prepare(`SELECT * FROM opps WHERE ts >= ? ORDER BY ts DESC LIMIT 200`).bind(since).all();
      return { rows: r.results };
    }));
  }
  if (p === "/api/events") {
    let r = { results: [] };
    try { r = await cached(`events:${days}`, 60, () => env.DB.prepare(`SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 200`).bind(since).all()); } catch (_) { /* table not created yet */ }
    return json({ rows: r.results, rugAlarm: { priceDrop: PRICE_DROP, liquidityDrop: LIQ_DROP, pauseMinutes: PAUSE_MIN } });
  }
  if (p === "/api/faze") {
    // Coins Riptide reads every minute (Faze coins, plus WATCH entries marked show: latest price and liquidity, and
    // price 24 h ago), plus Faze launches and graduations.
    return json(await cached(`faze:${days}`, 60, async () => {
      const now = Math.floor(Date.now() / 1000);
      const pools = WATCH.filter(w => w.faze || w.show).concat(await graduatedWatch(env, now));
      const watched = [];
      for (const w of pools) {
        const last = await env.DB.prepare(`SELECT ts, price, liq FROM pool_state WHERE pool = ? AND pair = ? ORDER BY ts DESC LIMIT 1`).bind(w.pool, w.pair).first();
        const dayAgo = await env.DB.prepare(`SELECT price, liq FROM pool_state WHERE pool = ? AND pair = ? AND ts >= ? ORDER BY ts LIMIT 1`).bind(w.pool, w.pair, now - 86400).first();
        watched.push({ pair: w.pair, pool: w.pool, token: w.token, quote: !w.quote || [USDC, NATIVE].includes(w.quote.toLowerCase()) ? "USDC" : FAZE && w.quote.toLowerCase() === FAZE.token ? "FAZE" : w.quote,
          ts: last ? last.ts : null, price: last ? last.price : null, price24h: dayAgo ? dayAgo.price : null,
          liqChange24h: last && dayAgo && dayAgo.liq > 0 ? last.liq / dayAgo.liq - 1 : null });
      }
      let ev = { results: [] }, scanned = null;
      try {
        ev = await env.DB.prepare(`SELECT ts, kind, token, name, symbol, quote, pool_id, quote_seeded, tx FROM faze_events WHERE ts >= ? ORDER BY ts DESC LIMIT 100`).bind(since).all();
        scanned = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'faze_block'`).first();
      } catch (_) { /* tables not created yet */ }
      return { enabled: !!FAZE, watched, events: ev.results, scannedToBlock: scanned ? Number(scanned.v) : null, watchDays: FAZE ? FAZE.watchDays : null };
    }));
  }
  if (p === "/api/csv") {
    // Each download reads every sample in the window (tens of thousands of rows a day), so cap it at
    // 7 days and serve the same file for an hour, from the edge cache as well as this isolate.
    const d = Math.min(days, 7), from = Math.floor(Date.now() / 1000) - d * 86400;
    const cacheKey = new Request(`https://riptide-cache/csv?days=${d}`);
    const edge = caches.default;
    const hit = await edge.match(cacheKey);
    if (hit) return hit;
    const body = await cached(`csv:${d}`, 3600, async () => {
      const r = await env.DB.prepare(`SELECT * FROM samples WHERE ts >= ? ORDER BY ts`).bind(from).all();
      return [COLS.join(",")].concat(r.results.map(x => COLS.map(c => x[c] ?? "").join(","))).join("\n");
    });
    const res = new Response(body, { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename=riptide-${d}d.csv`,
      ...CORS, "cache-control": "public, max-age=3600" } });
    await edge.put(cacheKey, res.clone());
    return res;
  }
  return json({ name: "Riptide", endpoints: ["/api/latest", "/api/summary?days=7", "/api/series?days=7&size=1000", "/api/opps?days=7", "/api/events?days=7", "/api/faze?days=7", "/api/csv?days=7"] });
}

let schemaReady = false;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!schemaReady) { await ensureSchema(env, COLS, BUCKET); await ensureFazeSchema(env); schemaReady = true; }
      const rows = await sample(env);
      const ts = rows[0] ? rows[0].ts : Math.floor(Date.now() / 1000);
      // Rug alarm: read every watched pool, log sudden price drops / liquidity pulls, pause those pairs.
      const endpoints = endpointsOf(env);
      // Faze: pick up new launches and graduations, then watch freshly graduated pools along with the fixed list.
      const faze = await scanFaze(env, rpcBatch, endpoints).catch(e => { console.log("faze scan failed: " + (e.message || e)); return []; });
      const extra = await graduatedWatch(env, ts).catch(() => []);
      const events = await checkPools(env, ts, rpcBatch, endpoints, extra).catch(e => { console.log("rug check failed: " + (e.message || e)); return []; });
      const paused = await pausedPairs(env, ts);
      for (const r of rows) { const p = paused.get(r.pair); if (p) { r.alert = "paused: " + p.kind; r.would_trade = 0; } else r.alert = null; }
      for (const r of rows) if (WATCH_ONLY.has(r.pair)) { r.would_trade = 0; r.alert = r.alert || "watch only"; }
      await store(env, rows);
      const errs = [...new Set(rows.map(r => r.error).filter(Boolean))];
      console.log(`riptide: saved ${rows.length} rows` + (errs.length ? `; issues: ${errs.join(" | ")}` : "; all sources ok")
        + (faze.length ? `; faze: ${faze.map(e => `${e.kind} ${e.symbol || e.token}`).join(", ")}` : "")
        + (events.length ? `; ALARM: ${events.map(e => `${e.w.pair} ${e.w.pool} ${e.kind} ${(e.change * 100).toFixed(0)}%`).join(", ")}` : ""));
      // Keep RETENTION_DAYS. Once an hour is plenty for this.
      if (new Date().getUTCMinutes() !== 7) return;
      const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
      await env.DB.batch(["samples", "pool_state", "events", "opps"].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE ts < ?`).bind(cutoff))
        .concat(env.DB.prepare(`DELETE FROM rollup WHERE bucket < ?`).bind(cutoff)));
    })());
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "read-only" }, 405);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /api/csv\n", { headers: { "content-type": "text/plain" } });
    try { return await api(url, env); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};
