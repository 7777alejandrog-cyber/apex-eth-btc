/**
 * APEX ETH/BTC Execution Agent - Base Network
 * Graystone Confluence Method - HIGH CONVICTION ONLY
 * v2 - Calls Anthropic API directly, no OpenRouter
 */

import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";

const CONFIG = {
  SMART_WALLET:    "0x91F355846EE6d8f516B30C28794145e8139192b0" as `0x${string}`,
  AERODROME_ROUTER:"0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  TOKENS: {
    WETH:  "0x4200000000000000000000000000000000000006",
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    USDC:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  MIN_CONFIDENCE:  80,
  MIN_RR:          2.0,
  MIN_VOLUME_ETH:  100_000_000,
  MIN_VOLUME_BTC:  50_000_000,
  POSITION_PCT:    0.8,
  ANTHROPIC_KEY:   process.env.ANTHROPIC_API_KEY || "",
};

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

async function fetchMarketData() {
  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=1h,24h,7d";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const data = await res.json();
  return data.map((c: any) => ({
    symbol:    c.symbol.toUpperCase() === "BTC" ? "BTC" : "ETH",
    price:     c.current_price,
    change1h:  c.price_change_percentage_1h_in_currency ?? 0,
    change24h: c.price_change_percentage_24h_in_currency ?? 0,
    change7d:  c.price_change_percentage_7d_in_currency ?? 0,
    volume24h: c.total_volume,
  }));
}

async function runGraystoneAnalysis(market: any) {
  const prompt = `You are APEX, elite crypto trading AI using Graystone confluence method.
LIVE DATA for ${market.symbol}: Price $${market.price.toFixed(2)}, 1h ${market.change1h.toFixed(2)}%, 24h ${market.change24h.toFixed(2)}%, 7d ${market.change7d.toFixed(2)}%, Vol $${(market.volume24h/1e9).toFixed(2)}B
RULES: ALL 3 timeframes must align. Any conflict = NO_TRADE. Be honest with confidence.
Respond ONLY with JSON (no markdown): {"signals":[{"timeframe":"1h","direction":"BULL","strength":75,"reason":"reason"},{"timeframe":"24h","direction":"BULL","strength":70,"reason":"reason"},{"timeframe":"7d","direction":"BULL","strength":65,"reason":"reason"}],"confluence":"LONG","confidence":82,"entry":${market.price.toFixed(2)},"target":${(market.price*1.06).toFixed(2)},"stop":${(market.price*0.97).toFixed(2)},"rr":2.0,"reasoning":"one sentence"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";

  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    const entry = parsed.entry || market.price;
    const target = parsed.target || market.price * 1.06;
    const stop = parsed.stop || market.price * 0.97;
    const rr = Math.abs(target - entry) / Math.abs(entry - stop);
    return { ...parsed, asset: market.symbol, price: market.price, volume24h: market.volume24h, rr: Math.round(rr*10)/10, entry, target, stop };
  } catch {
    return { asset: market.symbol, price: market.price, signals: [], confluence: "NO_TRADE", confidence: 0, rr: 0, entry: market.price, target: market.price, stop: market.price, volume24h: market.volume24h, reasoning: "Parse error" };
  }
}

function passesFilter(a: any): boolean {
  const minVol = a.asset === "ETH" ? CONFIG.MIN_VOLUME_ETH : CONFIG.MIN_VOLUME_BTC;
  if (a.confluence === "NO_TRADE" || a.confidence < CONFIG.MIN_CONFIDENCE || a.rr < CONFIG.MIN_RR || a.volume24h < minVol) return false;
  const dirs = a.signals.map((s: any) => s.direction).filter((d: string) => d !== "NEUTRAL");
  return dirs.every((d: string) => d === "BULL") || dirs.every((d: string) => d === "BEAR");
}

function printSignal(a: any, bal: number) {
  const size = (bal * CONFIG.POSITION_PCT * a.price).toFixed(2);
  const L = "=".repeat(56);
  console.log(`\n+${L}+`);
  console.log(`| APEX SIGNAL - ${a.asset} ${a.confluence}`);
  console.log(`| Confidence: ${a.confidence}% | R:R: ${a.rr}:1`);
  console.log(`| Entry: $${a.entry.toFixed(2)} | Target: $${a.target.toFixed(2)} | Stop: $${a.stop.toFixed(2)}`);
  console.log(`| Size: ~$${size} | Why: ${a.reasoning}`);
  console.log(`| ACTION: Go to aerodrome.finance on Base`);
  console.log(`| Swap USDC -> ${a.asset} | Amount: $${size}`);
  console.log(`+${L}+\n`);
}

async function getBalance(): Promise<number> {
  const wei = await publicClient.getBalance({ address: CONFIG.SMART_WALLET });
  return parseFloat(formatUnits(wei, 18));
}

async function runAPEX() {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  console.log(`\n APEX ETH/BTC - ${ts} PT`);
  const balance = await getBalance();
  console.log(`   Balance: ${balance.toFixed(4)} ETH`);
  if (balance < 0.005) { console.log("Balance too low - need 0.005+ ETH"); return; }
  console.log("\n Fetching market data...");
  const markets = await fetchMarketData();
  for (const m of markets) console.log(`   ${m.symbol}: $${m.price.toLocaleString()} | 1h: ${m.change1h.toFixed(2)}% | 24h: ${m.change24h.toFixed(2)}% | 7d: ${m.change7d.toFixed(2)}%`);
  console.log("\n Running Graystone analysis...");
  const results = await Promise.all(markets.map(runGraystoneAnalysis));
  let signals = 0;
  for (const a of results) {
    console.log(`\n   ${a.asset}: ${a.confluence} | Conf: ${a.confidence}% | R:R: ${a.rr}:1`);
    if (!passesFilter(a)) { console.log(`   REJECTED: ${a.reasoning}`); continue; }
    console.log("   ALL FILTERS PASSED");
    printSignal(a, balance);
    signals++;
  }
  if (signals === 0) console.log("\n No signals this scan. Next in 1 hour.\n");
  else console.log(`\n ${signals} signal(s) generated above.\n`);
}

async function start() {
  await runAPEX().catch(console.error);
  setInterval(() => runAPEX().catch(console.error), 60 * 60 * 1000);
}

start();
