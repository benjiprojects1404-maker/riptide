// Riptide configuration: everything chain-specific lives here.
// The values below are the live Arc mainnet setup (chain 5042), kept as a working example.
// To point Riptide at another EVM chain with Uniswap v3 (and optionally v4) pools, change this file only.
// Check every address on the chain's explorer before deploying; scripts/check-pool.js helps with v4 pools.

// The chain. chainId is checked against every RPC before its answers are trusted.
// nativeUsd: price of the gas token in USD. A number (Arc pays gas in USDC, so 1), or a Coinbase product
// such as "ETH-USD" to read the live price each minute.
export const CHAIN = {
  name: "Arc",
  chainId: 5042,
  rpc: "https://rpc.mainnet.arc.io",   // public fallback; set the RPC_URL secret for a private endpoint
  nativeDecimals: 18,
  nativeUsd: 1,
  explorer: null,                       // block explorer URL, optional
};

// The USD stablecoin every pair is quoted against.
export const USDC = "0x3600000000000000000000000000000000000000"; // USDC ERC-20 interface on Arc
export const USDC_DEC = 6;
// The chain's native currency as a Uniswap v4 currency (address zero). On Arc this is native USDC (18 decimals).
export const NATIVE = "0x0000000000000000000000000000000000000000";

// Uniswap contracts on this chain.
export const QUOTER = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";     // v3 QuoterV2
export const QUOTER_V4 = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";  // v4 V4Quoter (null if the chain has no v4)
export const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"; // v4 StateView (null if the chain has no v4)

export const SIZES = [10, 1000];      // trade sizes in USD
export const GAS_UNITS = 110000n;     // typical v3 single swap; read QuoterV2's gasEstimate on your chain
export const COINBASE_FEE = 0.006;    // assumed Coinbase taker fee
export const RETENTION_DAYS = 30;     // raw samples kept in D1

// Pairs compared with a centralised exchange.
// cexFee is the assumed taker fee per trade (fraction). Shown on the dashboard as an assumption.
// ref: "binance" (sym like BTCUSDC; cb is the Coinbase fallback, since Binance blocks some Cloudflare regions)
//   or "coinbase" (sym like EURC-USDC). poolFee is the Uniswap v3 fee tier (100 = 0.01%, 500, 3000, 10000).
export const PAIRS = [
  { id: "cirBTC", token: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8,  poolFee: 100, ref: "binance",  sym: "BTCUSDC",   cexFee: 0.001, cb: "BTC-USD" },
  { id: "EURC",   token: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6,  poolFee: 500, ref: "coinbase", sym: "EURC-USDC", cexFee: 0.006 },
  { id: "WETH",   token: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18, poolFee: 3000, ref: "binance", sym: "ETHUSDC",   cexFee: 0.001, cb: "ETH-USD" },
];

// Same-chain pairs: the same token in two or more pools. Riptide buys in the "home" pool and sells the same tokens
// in each other pool (and the reverse), using chained real quotes. For tokens with no exchange listing.
// v3 venues: { kind: "v3", fee }. v4 venues: { kind: "v4", quote, qdec, fee, tickSpacing, hooks }.
// ARGUS: home is the Uniswap v3 1% pool; the others are the v4 ARGUS/USDC pools with real liquidity and sane fees.
// FAZE: home is Faze's own graduated pool (native USDC against FAZE, through Faze's launchpad hook);
// the other is the deepest plain v4 FAZE/USDC pool.
const ZERO_HOOK = "0x0000000000000000000000000000000000000000";
const FAZE_HOOK = "0x47e7936ae9891e61c5123db720593c05de7120cc";  // Faze LaunchpadHook
export const VENUE_PAIRS = [
  { id: "ARGUS", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18,
    home: { kind: "v3", fee: 10000, label: "v3 1%" },
    others: [ { kind: "v4", quote: USDC, qdec: 6, fee: 9850, tickSpacing: 99, hooks: ZERO_HOOK, label: "v4 0.985%" },
              { kind: "v4", quote: USDC, qdec: 6, fee: 40000, tickSpacing: 200, hooks: ZERO_HOOK, label: "v4 4%" } ] },
  { id: "FAZE", token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e", dec: 18,
    home: { kind: "v4", quote: NATIVE, qdec: 18, fee: 0, tickSpacing: 200, hooks: FAZE_HOOK, label: "Faze pool" },
    others: [ { kind: "v4", quote: USDC, qdec: 6, fee: 50000, tickSpacing: 100, hooks: ZERO_HOOK, label: "v4 5%" } ] },
];

// Rug alarm watch list: every pool to read each minute. v3 pools by address; v4 pools by pool id.
// quote/qdec default to USDC/USDC_DEC. show: true lists the coin in the dashboard's coin watch table.
export const WATCH = [
  { pair: "cirBTC", pool: "v3 0.01%", kind: "v3", address: "0x82916bee18fcef517b26c72d7cb5f13694e1db41", token: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8 },
  { pair: "EURC",   pool: "v3 0.05%", kind: "v3", address: "0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1", token: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6 },
  { pair: "WETH",   pool: "v3 0.3%",  kind: "v3", address: "0x964cff2cccb9059e83d507df348f070e5257a2e0", token: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18 },
  { pair: "ARGUS",  pool: "v3 1%",    kind: "v3", address: "0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  { pair: "ARGUS",  pool: "v4 0.985%", kind: "v4", id: "0xb3f441e8871840ecfcb284e5cbb5b9c21a50e961e1c50109bdced25e429f00cc", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  { pair: "ARGUS",  pool: "v4 4%",    kind: "v4", id: "0xebde8959fac1a0a1f837189e7f00f40566f4c1fc6efa3b3c987222222fd31455", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  // Faze (faze.fun) coins. Their main pools are the graduated Faze pools: native USDC (18 decimals) against the coin,
  // through Faze's launchpad hook, which takes the trading fee. Pool ids checked on Arc mainnet, 2 Nov 2026.
  { pair: "FAZE",   pool: "Faze pool", kind: "v4", id: "0xd9133187331e20885fd1b4ff2f18b892f94793ddaf808b1db6d4ef29ca58b943", token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e", dec: 18, quote: NATIVE, qdec: 18, faze: true },
  { pair: "FAZE",   pool: "v4 5%",     kind: "v4", id: "0xcb4925117715e6983ee6e03d491d90bbc498776b761714c447a9ea80265ca846", token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e", dec: 18 },
  // ArcStocks (ASTOCK), added 4 Nov 2026: no exchange listing and one Uniswap v4 ASTOCK/USDC pool, so it is watched
  // (price, liquidity, rug alarm) rather than compared. Pool and quote currency checked with scripts/check-pool.js.
  // show: listed in the dashboard's coin watch table.
  { pair: "ASTOCK", pool: "v4",        kind: "v4", id: "0x1bb5c22ae4560dc887164d96ebeaa756130948314ce132fee3c8d14e5b95758b", token: "0x4c9b47dbd5933aa4574b2c27f82419e4dbbd0222", dec: 18, show: true },
  { pair: "AF",     pool: "Faze pool", kind: "v4", id: "0x1c0523377296238f6a2fd25cb3b15f75e280eb330ad29f843b974eec264dfe31", token: "0x75d658f8101fbe6dc217fbba7e20a0312af5fa2e", dec: 18, quote: NATIVE, qdec: 18, faze: true },
];

// Faze (faze.fun) launchpad watch, Arc only. Set to null on any other chain (or to turn it off):
// the dashboard hides the Faze sections when it is null.
export const FAZE = {
  bondingCurve: "0x6a62919ccbf0c19e0c4e084f986b582b4492dda4",
  migrator: "0x7c8de42426a058b778dce8530537cd62ef0178c4",
  launchpadHook: FAZE_HOOK,
  token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e",
  chunk: 1900,          // Arc's public RPC refuses log ranges much over 2,000 blocks
  chunksPerRun: 3,      // catch up at most ~5,700 blocks per minute
  backfillDays: 3,      // on the first run, start this far back
  blocksPerSecond: 2,   // Arc makes ~2 blocks a second
  watchDays: 7,         // watch each graduated pool this long
};
