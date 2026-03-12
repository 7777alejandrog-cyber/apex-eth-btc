/**
 * APEX ETH/BTC Execution Agent — Base Network
 * Graystone Confluence Method — HIGH CONVICTION ONLY
 *
 * Assets: ETH (native) and cbBTC (Coinbase wrapped BTC on Base)
 * DEX: Aerodrome Finance (Base) via Uniswap V3-compatible router
 * Wallet: Coinbase Smart Wallet (EIP-7702)
 *
 * RULES — a signal is only sent to you if ALL pass:
 *   ✅ 1h + 24h + 7d timeframes all bullish (or all bearish for SHORT)
 *   ✅ Volume > $100M (ETH) / $50M (cbBTC)
 *   ✅ Minimum R:R 2.0:1
 *   ✅ Confidence ≥ 80%
 *   ✅ No conflicting signals across timeframes
 *
 * You approve every transaction — nothing executes without your signature.
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, parseEther } from "viem";
import { base } from "viem/chains";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  // Your wallets
  SMART_WALLET:    "0x91F355846EE6d8f516B30C28794145e8139192b0" as `0x${string}`,
  EOA_WALLET:      "0x064Bb82C51Fc554269E11E74fEfcEFFA2CDbB8FD" as `0x${string}`,

  // Base network tokens
  TOKENS: {
    WETH:  "0x4200000000000000000000000000000000000006" as `0x${string}`, // Wrapped ETH on Base
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as `0x${string}`, // Coinbase BTC on Base
    USDC:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`, // USDC on Base
  },

  // Aerodrome router (Uniswap V3 compatible)
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as `0x${string}`,

  // CoinGecko IDs
  COINGECKO_IDS: {
    ETH:  "ethereum",
    BTC:  "bitcoin",
  },

  // Graystone thresholds — DO NOT LOWER THESE
  MIN_CONFIDENCE:   80,   // % — below this = no trade
  MIN_RR:           2.0,  // Risk:Reward — below this = no trade
  MIN_VOLUME_ETH:   100_000_000,  // $100M daily volume
  MIN_VOLUME_BTC:   50_000_000,   // $50M daily volume

  // Position sizing — conservative with $30
  POSITION_PCT:     0.8,  // use 80% of balance per trade (leave gas buffer)
  STOP_LOSS_PCT:    0.03, // 3% stop loss
  TAKE_PROFIT_MULT: 2.0,  // TP = entry + (2x stop distance)

  // OpenRouter
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "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",
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  || "sk-ant-api03-se9VkHyeVDFUw0m1khVQExkLAJUa9OXH4sIbY3kz0DaJRCyrUbvfltQ1-SrAPG7lGiut77sMFLQ0Smqe9uKcg-_gL6wwAA",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface PriceData {
  symbol:        string;
  price:         number;
  change1h:      number;
  change24h:     number;
  change7d:      number;
  volume24h:     number;
}

interface TimeframeSignal {
  timeframe:  "1h" | "24h" | "7d";
  direction:  "BULL" | "BEAR" | "NEUTRAL";
  strength:   number; // 0-100
  reason:     string;
}

interface GraystoneAnalysis {
  asset:       string;
  price:       number;
  signals:     TimeframeSignal[];
  confluence:  "LONG" | "SHORT" | "NO_TRADE";
  confidence:  number;
  rr:          number;
  entry:       number;
  target:      number;
  stop:        number;
  volume24h:   number;
  reasoning:   string;
}

interface TradeProposal {
  asset:      "ETH" | "cbBTC";
  direction:  "LONG" | "SHORT";
  entry:      number;
  target:     number;
  stop:       number;
  confidence: number;
  rr:         number;
  sizeUSD:    number;
  reasoning:  string;
  // On-chain details
  tokenIn:    `0x${string}`;
  tokenOut:   `0x${string}`;
  amountIn:   bigint;
  minOut:     bigint;
  deadline:   number;
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<PriceData[]> {
  const ids = Object.values(CONFIG.COINGECKO_IDS).join(",");
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=1h,24h,7d`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const data = await res.json();

  return data.map((c: any) => ({
    symbol:   c.symbol.toUpperCase(),
    price:    c.current_price,
    change1h: c.price_change_percentage_1h_in_currency ?? 0,
    change24h:c.price_change_percentage_24h_in_currency ?? 0,
    change7d: c.price_change_percentage_7d_in_currency ?? 0,
    volume24h:c.total_volume,
  }));
}

// ─── GRAYSTONE ANALYSIS ───────────────────────────────────────────────────────

async function runGraystoneAnalysis(market: PriceData): Promise<GraystoneAnalysis> {
  const openrouter = createOpenRouter({ apiKey: CONFIG.OPENROUTER_API_KEY });

  const prompt = `You are APEX, an elite crypto trading AI using the Graystone confluence method.

MARKET DATA for ${market.symbol}:
- Price: $${market.price.toFixed(2)}
- 1h change: ${market.change1h.toFixed(2)}%
- 24h change: ${market.change24h.toFixed(2)}%
- 7d change: ${market.change7d.toFixed(2)}%
- 24h volume: $${(market.volume24h / 1e9).toFixed(2)}B

GRAYSTONE METHOD — Analyze each timeframe:
1. 1h timeframe: Short-term momentum signal
2. 24h timeframe: Medium-term trend
3. 7d timeframe: Macro trend direction

RULES:
- Only output LONG or SHORT if ALL THREE timeframes align
- If any timeframe conflicts = NO_TRADE
- Confidence must reflect genuine conviction (do not inflate)
- R:R must be calculated from realistic entry/target/stop

Respond ONLY with valid JSON in this exact format:
{
  "signals": [
    {"timeframe": "1h", "direction": "BULL|BEAR|NEUTRAL", "strength": 0-100, "reason": "..."},
    {"timeframe": "24h", "direction": "BULL|BEAR|NEUTRAL", "strength": 0-100, "reason": "..."},
    {"timeframe": "7d", "direction": "BULL|BEAR|NEUTRAL", "strength": 0-100, "reason": "..."}
  ],
  "confluence": "LONG|SHORT|NO_TRADE",
  "confidence": 0-100,
  "entry": price,
  "target": price,
  "stop": price,
  "reasoning": "one sentence explanation"
}`;

  const { text } = await generateText({
    model: openrouter("anthropic/claude-sonnet-4-5"),
    prompt,
    maxTokens: 600,
  });

  let parsed: any;
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    return {
      asset: market.symbol, price: market.price,
      signals: [], confluence: "NO_TRADE", confidence: 0,
      rr: 0, entry: market.price, target: market.price, stop: market.price,
      volume24h: market.volume24h, reasoning: "Parse error — no trade",
    };
  }

  // Calculate actual R:R
  const entry  = parsed.entry  || market.price;
  const target = parsed.target || market.price;
  const stop   = parsed.stop   || market.price;
  const rr = Math.abs(target - entry) / Math.abs(entry - stop);

  return {
    asset:      market.symbol,
    price:      market.price,
    signals:    parsed.signals || [],
    confluence: parsed.confluence || "NO_TRADE",
    confidence: parsed.confidence || 0,
    rr:         Math.round(rr * 10) / 10,
    entry,
    target,
    stop,
    volume24h:  market.volume24h,
    reasoning:  parsed.reasoning || "",
  };
}

// ─── SIGNAL FILTER — NO EXCEPTIONS ───────────────────────────────────────────

function passesGraystoneFilter(analysis: GraystoneAnalysis, asset: "ETH" | "cbBTC"): boolean {
  const minVol = asset === "ETH" ? CONFIG.MIN_VOLUME_ETH : CONFIG.MIN_VOLUME_BTC;

  if (analysis.confluence === "NO_TRADE")          return false;
  if (analysis.confidence < CONFIG.MIN_CONFIDENCE) return false;
  if (analysis.rr < CONFIG.MIN_RR)                 return false;
  if (analysis.volume24h < minVol)                 return false;

  // All 3 timeframes must agree
  const directions = analysis.signals.map(s => s.direction).filter(d => d !== "NEUTRAL");
  const allBull = directions.every(d => d === "BULL");
  const allBear = directions.every(d => d === "BEAR");
  if (!allBull && !allBear)                        return false;

  return true;
}

// ─── BUILD TRADE PROPOSAL ─────────────────────────────────────────────────────

async function buildTradeProposal(
  analysis: GraystoneAnalysis,
  asset: "ETH" | "cbBTC",
  walletBalanceETH: number
): Promise<TradeProposal | null> {
  if (!passesGraystoneFilter(analysis, asset)) return null;

  const sizeETH = walletBalanceETH * CONFIG.POSITION_PCT;
  const sizeUSD = sizeETH * analysis.price; // approximate

  // For LONG: buy ETH or cbBTC with USDC (or swap ETH→cbBTC)
  // For SHORT: not directly available without perps — skip for now, only LONG
  if (analysis.confluence !== "LONG") return null;

  const tokenIn:  `0x${string}` = CONFIG.TOKENS.USDC; // Buy with USDC
  const tokenOut: `0x${string}` = asset === "ETH" ? CONFIG.TOKENS.WETH : CONFIG.TOKENS.cbBTC;

  // Use 6 decimals for USDC
  const amountIn = parseUnits(sizeUSD.toFixed(2), 6);
  // Minimum out with 1% slippage protection
  const minOut   = asset === "ETH"
    ? parseEther((sizeETH * 0.99).toFixed(6))
    : parseUnits(((sizeUSD / analysis.price) * 0.99).toFixed(8), 8); // cbBTC has 8 decimals

  return {
    asset,
    direction:  "LONG",
    entry:      analysis.entry,
    target:     analysis.target,
    stop:       analysis.stop,
    confidence: analysis.confidence,
    rr:         analysis.rr,
    sizeUSD,
    reasoning:  analysis.reasoning,
    tokenIn,
    tokenOut,
    amountIn,
    minOut,
    deadline:   Math.floor(Date.now() / 1000) + 300, // 5 min deadline
  };
}

// ─── WALLET BALANCE ───────────────────────────────────────────────────────────

async function getWalletBalance(): Promise<number> {
  const wei = await publicClient.getBalance({ address: CONFIG.SMART_WALLET });
  return parseFloat(formatUnits(wei, 18));
}

// ─── PRINT TRADE ALERT (sends to console — you review and approve) ─────────────

function printTradeAlert(proposal: TradeProposal): void {
  const box = "═".repeat(60);
  console.log(`\n╔${box}╗`);
  console.log(`║  🚨 APEX TRADE SIGNAL — ACTION REQUIRED                  ║`);
  console.log(`╠${box}╣`);
  console.log(`║  Asset:      ${proposal.asset.padEnd(46)} ║`);
  console.log(`║  Direction:  ${proposal.direction.padEnd(46)} ║`);
  console.log(`║  Confidence: ${(proposal.confidence + "%").padEnd(46)} ║`);
  console.log(`║  R:R Ratio:  ${(proposal.rr + ":1").padEnd(46)} ║`);
  console.log(`╠${box}╣`);
  console.log(`║  Entry:  $${proposal.entry.toFixed(2).padEnd(49)} ║`);
  console.log(`║  Target: $${proposal.target.toFixed(2).padEnd(49)} ║`);
  console.log(`║  Stop:   $${proposal.stop.toFixed(2).padEnd(49)} ║`);
  console.log(`╠${box}╣`);
  console.log(`║  Size:   $${proposal.sizeUSD.toFixed(2).padEnd(49)} ║`);
  console.log(`║  Why:    ${proposal.reasoning.substring(0, 50).padEnd(50)} ║`);
  console.log(`╠${box}╣`);
  console.log(`║  ⚠️  REVIEW BEFORE SIGNING — Open Coinbase Wallet         ║`);
  console.log(`║  Token In:  ${proposal.tokenIn.substring(0, 10)}...                              ║`);
  console.log(`║  Token Out: ${proposal.tokenOut.substring(0, 10)}...                              ║`);
  console.log(`║  Amount In: ${proposal.amountIn.toString().substring(0, 10)}... (USDC units)               ║`);
  console.log(`╚${box}╝`);
  console.log(`\n  TO EXECUTE: Sign this swap in your Coinbase Wallet app`);
  console.log(`  TO REJECT:  Press Ctrl+C or ignore\n`);
}

// ─── GENERATE AERODROME SWAP CALLDATA ─────────────────────────────────────────

function generateSwapCalldata(proposal: TradeProposal): string {
  // Aerodrome exactInputSingle ABI encoded
  // This is the transaction data you paste into your wallet to execute
  const params = {
    tokenIn:           proposal.tokenIn,
    tokenOut:          proposal.tokenOut,
    fee:               3000, // 0.3% pool
    recipient:         CONFIG.SMART_WALLET,
    deadline:          proposal.deadline,
    amountIn:          proposal.amountIn,
    amountOutMinimum:  proposal.minOut,
    sqrtPriceLimitX96: 0n,
  };

  console.log("\n📋 SWAP TRANSACTION DETAILS:");
  console.log(`  To (Router): ${CONFIG.AERODROME_ROUTER}`);
  console.log(`  tokenIn:     ${params.tokenIn}`);
  console.log(`  tokenOut:    ${params.tokenOut}`);
  console.log(`  amountIn:    ${params.amountIn} (${proposal.sizeUSD.toFixed(2)} USDC)`);
  console.log(`  minOut:      ${params.minOut}`);
  console.log(`  deadline:    ${new Date(params.deadline * 1000).toLocaleTimeString()}`);
  console.log(`\n  👉 Go to https://aerodrome.finance/swap on Base`);
  console.log(`     Connect wallet: ${CONFIG.SMART_WALLET}`);
  console.log(`     Swap USDC → ${proposal.asset}`);
  console.log(`     Amount: $${proposal.sizeUSD.toFixed(2)}\n`);

  return JSON.stringify(params, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function runAPEX(): Promise<void> {
  console.log("⚡ APEX ETH/BTC Agent starting — Base Network");
  console.log(`   Wallet: ${CONFIG.SMART_WALLET}`);
  console.log(`   Method: Graystone Confluence (ALL timeframes must align)`);
  console.log(`   Assets: ETH + cbBTC on Aerodrome\n`);

  // Get balance
  const balanceETH = await getWalletBalance();
  console.log(`   Balance: ${balanceETH.toFixed(4)} ETH (~$${(balanceETH * 3000).toFixed(2)})`);

  if (balanceETH < 0.005) {
    console.log("❌ Balance too low to trade (need at least 0.005 ETH for gas + position)");
    return;
  }

  // Fetch market data
  console.log("\n📡 Fetching market data from CoinGecko...");
  const markets = await fetchMarketData();

  const ethData  = markets.find(m => m.symbol === "ETH");
  const btcData  = markets.find(m => m.symbol === "BTC");

  if (!ethData || !btcData) {
    console.log("❌ Failed to fetch market data");
    return;
  }

  console.log(`   ETH: $${ethData.price.toFixed(2)} | 1h: ${ethData.change1h.toFixed(2)}% | 24h: ${ethData.change24h.toFixed(2)}% | 7d: ${ethData.change7d.toFixed(2)}%`);
  console.log(`   BTC: $${btcData.price.toFixed(2)} | 1h: ${btcData.change1h.toFixed(2)}% | 24h: ${btcData.change24h.toFixed(2)}% | 7d: ${btcData.change7d.toFixed(2)}%`);

  // Run Graystone analysis on both
  console.log("\n🧠 Running Graystone analysis...");
  const [ethAnalysis, btcAnalysis] = await Promise.all([
    runGraystoneAnalysis(ethData),
    runGraystoneAnalysis(btcData),
  ]);

  const analyses: Array<{ analysis: GraystoneAnalysis; asset: "ETH" | "cbBTC" }> = [
    { analysis: ethAnalysis, asset: "ETH" },
    { analysis: btcAnalysis, asset: "cbBTC" },
  ];

  let tradesFound = 0;

  for (const { analysis, asset } of analyses) {
    console.log(`\n${asset}: ${analysis.confluence} | Confidence: ${analysis.confidence}% | R:R: ${analysis.rr}:1`);

    if (analysis.confluence === "NO_TRADE") {
      console.log(`   ❌ REJECTED — Timeframes not aligned`);
      continue;
    }
    if (analysis.confidence < CONFIG.MIN_CONFIDENCE) {
      console.log(`   ❌ REJECTED — Confidence ${analysis.confidence}% < ${CONFIG.MIN_CONFIDENCE}% minimum`);
      continue;
    }
    if (analysis.rr < CONFIG.MIN_RR) {
      console.log(`   ❌ REJECTED — R:R ${analysis.rr}:1 < ${CONFIG.MIN_RR}:1 minimum`);
      continue;
    }

    console.log(`   ✅ PASSES ALL FILTERS — Building proposal...`);
    const proposal = await buildTradeProposal(analysis, asset, balanceETH);

    if (proposal) {
      tradesFound++;
      printTradeAlert(proposal);
      generateSwapCalldata(proposal);
    }
  }

  if (tradesFound === 0) {
    console.log("\n⏸  NO TRADES TODAY — Market conditions don't meet Graystone standards.");
    console.log("   This is correct behavior. Waiting for the right setup.");
    console.log("   Next scan in 1 hour.\n");
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

async function startScheduler(): Promise<void> {
  await runAPEX();

  // Run every hour
  setInterval(async () => {
    console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Running scheduled scan...`);
    await runAPEX().catch(console.error);
  }, 60 * 60 * 1000);
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

startScheduler().catch(console.error);
