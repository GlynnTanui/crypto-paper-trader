import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, STEP, WARMUP, STARTING_BALANCE, hash, iso } from './config.js';
import { fetchMarket, validateMarket } from './market.js';
import { createState, processMarket, liquidateBacktest } from './engine.js';
import { readJson, writeJson } from './storage.js';

export function backtest(market, from, to, config = CONFIG) {
  const selected = Object.fromEntries(config.symbols.map((symbol) => [
    symbol, market[symbol].filter((bar) => Date.parse(bar.time) >= from - WARMUP * STEP && Date.parse(bar.time) < to)
  ]));
  validateMarket(selected, { config, from: from - WARMUP * STEP, to });
  let state = processMarket(createState(iso(from), config), selected, { config, startTime: from });
  state = liquidateBacktest(state, selected, config);
  const trades = state.fills.filter((fill) => fill.side === 'SELL');
  const profits = trades.reduce((sum, fill) => sum + Math.max(0, fill.realizedPnl), 0);
  const losses = -trades.reduce((sum, fill) => sum + Math.min(0, fill.realizedPnl), 0);
  let buyAndHold = 0;
  for (const symbol of config.symbols) {
    const first = selected[symbol].find((bar) => Date.parse(bar.time) === from);
    const last = selected[symbol].at(-1);
    const quantity = (STARTING_BALANCE / config.symbols.length) / (first.open * (1 + config.slippageRate) * (1 + config.feeRate));
    buyAndHold += quantity * last.close * (1 - config.slippageRate) * (1 - config.feeRate);
  }
  return {
    from: iso(from), to: iso(to), startingBalance: STARTING_BALANCE, endingEquity: state.equity,
    netReturnPct: (state.equity / STARTING_BALANCE - 1) * 100, maxDrawdownPct: state.maxDrawdownPct,
    tradeCount: trades.length, winRatePct: trades.length ? trades.filter((f) => f.realizedPnl > 0).length / trades.length * 100 : 0,
    profitFactor: losses > 0 ? profits / losses : null, totalFees: state.totalFees,
    cashReturnPct: 0, buyAndHoldReturnPct: (buyAndHold / STARTING_BALANCE - 1) * 100,
    feeRate: config.feeRate, slippageRate: config.slippageRate,
    riskHalt: state.riskHalt
  };
}

export async function research({ directory = 'runtime', days = 90, now = Date.now(), useCache = false } = {}) {
  if (!Number.isInteger(days) || days < 60 || days > 180) throw new Error('Research must cover 60-180 days');
  const path = join(directory, 'research-candles.json');
  let market, from, to;
  if (useCache) {
    const cached = await readJson(path);
    ({ market, from, to } = cached);
    validateMarket(market, { from: from - WARMUP * STEP, to, now });
  } else {
    // Complete UTC days define a reproducible 2/3 training, 1/3 untouched holdout split.
    to = Date.parse(`${iso(now).slice(0, 10)}T00:00:00.000Z`);
    from = to - days * 24 * 60 * 60_000;
    market = await fetchMarket(from - WARMUP * STEP, to, { now });
    await writeJson(path, { provider: 'Coinbase Exchange', from, to, market });
  }
  const split = from + Math.floor((to - from) / STEP * 2 / 3) * STEP;
  const training = backtest(market, from, split);
  const holdout = backtest(market, split, to);
  const stressConfig = { ...CONFIG, feeRate: CONFIG.feeRate * 2, slippageRate: CONFIG.slippageRate * 2 };
  const stress = backtest(market, split, to, stressConfig);
  const report = {
    generatedAt: iso(now), provider: 'Coinbase Exchange', symbols: CONFIG.symbols, intervalMinutes: CONFIG.intervalMinutes,
    parameters: CONFIG, parameterHash: hash(CONFIG),
    assessment: holdout.netReturnPct <= 0
      ? 'No validated profitability: the untouched holdout lost money after modeled costs. This is an educational paper experiment, not a profitable trading recommendation.'
      : 'No demonstrated future profitability: one historical holdout is insufficient evidence, even when its modeled return is positive.',
    methodology: 'Frozen rules; 60/30-day chronological split for a 90-day sample. No parameter fitting or holdout selection. Independent $10,000 balances; 150 prior bars warmup per window. Signals at closed bars, earliest entry next open, adverse slippage and fees both sides, stop-first intrabar ordering, opening gaps, UTC session exits, terminal liquidation. Equal-weight fully invested BTC/ETH buy-and-hold uses identical costs; cash earns 0%. Candle-close drawdown only, not intrabar maximum. Stress reruns holdout with doubled fees and slippage, including cost-aware sizing.',
    data: { from: iso(from - WARMUP * STEP), to: iso(to), barsPerSymbol: Object.fromEntries(CONFIG.symbols.map((s) => [s, market[s].length])), sha256: hash(market) },
    split: { trainFrom: iso(from), trainTo: iso(split), holdoutFrom: iso(split), holdoutTo: iso(to) },
    training, holdout, stress
  };
  await writeJson(join(directory, 'research.json'), report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  research({ directory: process.env.DATA_DIR ?? 'runtime', useCache: process.argv.includes('--cached') })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
