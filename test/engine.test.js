import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, STEP, WARMUP, iso } from '../src/config.js';
import { ema, atr, signals } from '../src/indicators.js';
import { createState, validateState, processMarket, initializeForward, positionSize, applyControl } from '../src/engine.js';
import { validateMarket, validateCandles, fetchJson, fetchCandles } from '../src/market.js';
import { backtest } from '../src/research.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');
export function fixture(count = 220, changes = {}) {
  return Object.fromEntries(CONFIG.symbols.map((symbol) => [symbol, Array.from({ length: count }, (_, i) => {
    const trending = symbol === 'BTC-USD' && i >= WARMUP;
    const price = trending ? 102 : 100;
    const bar = { time: iso(START + i * STEP), open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 10 };
    if (symbol === 'BTC-USD' && i === WARMUP) Object.assign(bar, { open: 100, high: 102.2, low: 99.8 });
    return Object.assign(bar, changes[symbol]?.[i] ?? {});
  })]));
}
const slice = (market, start, end) => Object.fromEntries(CONFIG.symbols.map((s) => [s, market[s].slice(start, end)]));
const simulate = (market, config = CONFIG) => processMarket(createState(iso(START), config), market, { config });

test('EMA and Wilder ATR seed correctly and retain warmup nulls', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(ema([1, 2], 3), [null, null]);
  const candles = [{ high: 11, low: 9, close: 10 }, { high: 14, low: 12, close: 13 }, { high: 14, low: 10, close: 12 }];
  assert.deepEqual(atr(candles, 2), [null, 3, 3.5]);
  assert.throws(() => ema([1], 0));
});

test('breakout excludes the current high, and cannot use future bars', () => {
  const market = fixture();
  const before = signals(market['BTC-USD'].slice(0, 151), CONFIG);
  const after = signals(market['BTC-USD'], CONFIG);
  assert.deepEqual(after.slice(0, 151), before);
  assert.equal(before[149].signal, 'WAIT');
  assert.equal(before[150].signal, 'BUY SETUP');
  const state = simulate(slice(market, 0, 151));
  assert.equal(state.fills.length, 0);
  assert.equal(state.pending.length, 1);
  const entered = processMarket(state, slice(market, 0, 152));
  assert.equal(entered.fills[0].time, market['BTC-USD'][151].time);
  assert.ok(Math.abs(entered.fills[0].price - 102 * (1 + CONFIG.slippageRate)) < 1e-8);
});

test('risk sizing includes round-trip friction, cash and exposure caps', () => {
  const state = createState(iso(START));
  const order = { stop: 98, close: 100, atr: 1 };
  const quantity = positionSize(state, order, 100);
  const entry = 100 * 1.0005, exit = 98 * 0.9995;
  assert.ok(quantity * (entry - exit + (entry + exit) * 0.001) <= 25);
  assert.ok(quantity * entry <= 2500);
  assert.ok(quantity * entry * 1.001 <= state.cash);
  state.exposure = 4999;
  assert.ok(positionSize(state, order, 100) * entry <= 1);
  state.exposure = 5000;
  assert.equal(positionSize(state, order, 100), 0);
  assert.equal(positionSize(createState(), { ...order, stop: 101 }, 100), 0);
});

test('fees both sides and slippage reconcile cash and realized P&L', () => {
  const state = simulate(fixture(170));
  assert.equal(state.fills.length, 2);
  const [buy, sell] = state.fills;
  assert.equal(sell.reason, 'max-hold');
  assert.ok(buy.price > 102 && sell.price < 102);
  assert.ok(buy.fee > 0 && sell.fee > 0);
  assert.ok(Math.abs(state.cash - (10000 + sell.quantity * (sell.price - buy.price) - buy.fee - sell.fee)) < 1e-6);
  assert.equal(state.realizedPnl, sell.realizedPnl);
  assert.equal(state.positions.length, 0);
  assert.equal(Date.parse(sell.time) - Date.parse(buy.time), 16 * STEP);
  validateState(state);
});

test('same-bar stop wins when target is also touched, including entry bar', () => {
  const state = simulate(fixture(152, { 'BTC-USD': { 151: { open: 102, high: 112, low: 98, close: 102 } } }));
  assert.equal(state.fills[1].reason, 'stop');
  assert.ok(state.fills[1].realizedPnl < 0);
  assert.equal(state.fills[1].time, iso(START + 152 * STEP));
});

test('stop gaps fill at worse opening price; target gaps never receive favorable improvement', () => {
  const stopped = simulate(fixture(153, { 'BTC-USD': { 152: { open: 98, high: 99, low: 97, close: 98 } } }));
  assert.equal(stopped.fills[1].reason, 'gap-stop');
  assert.ok(Math.abs(stopped.fills[1].price - 98 * (1 - CONFIG.slippageRate)) < 1e-8);
  const market = fixture(153, { 'BTC-USD': { 152: { open: 110, high: 111, low: 109, close: 110 } } });
  const before = simulate(slice(market, 0, 152));
  const target = before.positions[0].target;
  const won = processMarket(before, market);
  assert.equal(won.fills[1].reason, 'gap-target');
  assert.ok(Math.abs(won.fills[1].price - target * (1 - CONFIG.slippageRate)) < 1e-7);
});

test('large entry gap skips setup and does not backfill', () => {
  const state = simulate(fixture(152, { 'BTC-USD': { 151: { open: 110, high: 111, low: 109, close: 110 } } }));
  assert.equal(state.fills.length, 0);
  assert.ok(state.activity.some((item) => item.message.includes('opening gap')));
});

test('daily loss blocks new entries then resets on UTC day boundary', () => {
  const config = { ...CONFIG, dailyLossLimit: 0.001 };
  const market = fixture(193, { 'BTC-USD': { 151: { high: 103, low: 98, close: 102 } } });
  const halted = simulate(slice(market, 0, 152), config);
  assert.equal(halted.riskHalt, 'daily-loss');
  assert.equal(halted.positions.length, 0);
  const reset = processMarket(halted, market, { config });
  assert.equal(reset.riskHalt, null);
  assert.equal(reset.day, '2026-01-03');
  assert.equal(reset.dayPnl, 0);
});

test('opening exit costs latch a breached guard before another asset can enter', () => {
  const market = fixture(153, {
    'BTC-USD': { 152: { open: 98, high: 99, low: 97, close: 98 } },
    'ETH-USD': {
      151: { open: 100, high: 102.2, low: 99.8, close: 102 },
      152: { open: 102, high: 110, low: 101.8, close: 109 }
    }
  });
  const before = simulate(slice(market, 0, 152));
  const quantity = before.positions[0].quantity;
  const beforeCosts = before.cash + quantity * 98;
  const afterCosts = before.cash + quantity * 98 * (1 - CONFIG.slippageRate) * (1 - CONFIG.feeRate);
  const floor = (beforeCosts + afterCosts) / 2;
  const config = { ...CONFIG, dailyLossLimit: (10000 - floor) / 10000 };
  const result = simulate(market, config);
  assert.ok(beforeCosts > floor && afterCosts < floor);
  assert.equal(result.riskHalt, 'daily-loss');
  assert.equal(result.fills.filter((fill) => fill.symbol === 'ETH-USD').length, 0);
  assert.equal(result.positions.length, 0);
});

test('maximum drawdown halt remains sticky across day resets and resume', () => {
  const config = { ...CONFIG, dailyLossLimit: 0.2, maxDrawdown: 0.001 };
  const market = fixture(193, { 'BTC-USD': { 151: { high: 103, low: 98, close: 102 } } });
  const state = simulate(market, config);
  assert.equal(state.riskHalt, 'max-drawdown');
  applyControl(state, 'resume', iso(START + 194 * STEP));
  assert.equal(state.riskHalt, 'max-drawdown');
  assert.ok(state.maxDrawdownPct >= 0.1);
});

test('pause discards pending entries but retains existing protective/time exits', () => {
  const market = fixture(170);
  const waiting = simulate(slice(market, 0, 151));
  applyControl(waiting, 'pause', iso(START + 151 * STEP));
  assert.equal(waiting.pending.length, 0);
  assert.equal(processMarket(waiting, market).fills.length, 0);
  const holding = simulate(slice(market, 0, 152));
  applyControl(holding, 'pause', iso(START + 152 * STEP));
  const exited = processMarket(holding, market);
  assert.equal(exited.fills.length, 2);
  assert.equal(exited.fills[1].reason, 'max-hold');
  assert.equal(exited.paused, true);
  assert.throws(() => applyControl(holding, 'reset', iso(START)));
});

test('positions are flat at UTC session end and no setup crosses midnight', () => {
  const market = fixture(194);
  for (let i = 150; i < 189; i++) market['BTC-USD'][i] = { ...market['ETH-USD'][i] };
  market['BTC-USD'][189] = { ...market['BTC-USD'][189], open: 100, low: 99.8, high: 102.2 };
  const state = simulate(market);
  assert.equal(state.fills[1].reason, 'UTC-session-end');
  assert.equal(state.fills[1].time, '2026-01-03T00:00:00.000Z');
});

test('two-symbol exposure and simultaneous-position limits apply at entry', () => {
  const market = fixture(152);
  market['ETH-USD'] = structuredClone(market['BTC-USD']);
  const state = simulate(market);
  assert.equal(state.positions.length, 2);
  assert.ok(state.exposure <= 5000);
  const capped = simulate(market, { ...CONFIG, maxPositions: 1 });
  assert.equal(capped.positions.length, 1);
});

test('reload, retry and arbitrary batching produce identical decisions and immutable fills', () => {
  const market = fixture();
  const whole = simulate(market);
  const reload = JSON.parse(JSON.stringify(whole));
  assert.deepEqual(processMarket(reload, market), whole);
  let incremental = simulate(slice(market, 0, 151));
  for (let i = 151; i < market['BTC-USD'].length; i++) {
    incremental = processMarket(JSON.parse(JSON.stringify(incremental)), slice(market, i - WARMUP, i + 1));
  }
  assert.deepEqual(incremental, whole);
  const corrupt = structuredClone(whole);
  corrupt.fills[0].price += 1;
  assert.throws(() => validateState(corrupt), /hash chain/);
  const brokenCash = structuredClone(whole);
  brokenCash.cash += 1;
  assert.throws(() => validateState(brokenCash), /reconciliation/);
});

test('new forward account uses history for warmup only, never imported backtest trades', () => {
  const market = fixture(170);
  const now = START + 170 * STEP + 5 * 60_000;
  const state = initializeForward(createState(iso(now)), market, now);
  assert.equal(state.equity, 10000);
  assert.equal(state.fills.length, 0);
  assert.equal(state.pending.length, 0);
  assert.equal(state.equityHistory.length, 1);
  assert.throws(() => initializeForward(state, market, now), /reinitialize/);
});

test('invalid, missing, unsynchronized, unclosed and stale market bars fail closed', () => {
  const market = fixture(170);
  const missing = structuredClone(market);
  missing['BTC-USD'].splice(160, 1);
  assert.throws(() => validateMarket(missing), /Missing/);
  const invalid = structuredClone(market);
  invalid['BTC-USD'][160].low = 1000;
  assert.throws(() => validateMarket(invalid), /OHLC/);
  assert.throws(() => validateCandles(market['BTC-USD'], { now: START }), /future/);
  assert.throws(() => validateMarket(market, { fresh: true, now: START + 175 * STEP }), /Stale/);
  const unsynced = structuredClone(market);
  unsynced['ETH-USD'].pop();
  assert.throws(() => validateMarket(unsynced), /identical/);
  assert.throws(() => simulate(slice(market, 0, 100)), /warmup/);
  const state = simulate(slice(market, 0, 151));
  assert.throws(() => processMarket(state, slice(fixture(400), 152)), /warmup|missing bar/);
});

test('HTTP retries are bounded and only transient statuses/network errors retry', async () => {
  let calls = 0;
  const wait = async () => {};
  const result = await fetchJson('https://example.invalid', {
    wait, fetcher: async () => { calls++; return calls < 3 ? new Response('', { status: 503 }) : Response.json([1]); }
  });
  assert.deepEqual(result, [1]);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(fetchJson('https://example.invalid', {
    wait, fetcher: async () => { calls++; return new Response('', { status: 403 }); }
  }), /403/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchJson('https://example.invalid', {
    wait, fetcher: async () => { calls++; throw new TypeError('Network unavailable'); }
  }), /network failure/);
  assert.equal(calls, 4);
});

test('Coinbase tuple mapping is strict and time coverage is complete', async () => {
  const fetcher = async () => Response.json([[START / 1000, 99, 101, 100, 100.5, 4]]);
  const bars = await fetchCandles('BTC-USD', START, START + STEP, { fetcher, wait: async () => {} });
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].close, 100.5);
  await assert.rejects(fetchCandles('BTC-USD', START, START + 2 * STEP, { fetcher, wait: async () => {} }), /incomplete/);
  await assert.rejects(fetchCandles('BTC-USDT', START, START + STEP), /Invalid/);
});

test('backtest charges final liquidation and supplies cash and net buy/hold comparisons', () => {
  const report = backtest(fixture(160), START + WARMUP * STEP, START + 160 * STEP);
  assert.equal(report.tradeCount, 1);
  assert.ok(report.totalFees > 0);
  assert.ok(report.netReturnPct < 0);
  assert.equal(report.cashReturnPct, 0);
  assert.ok(Number.isFinite(report.buyAndHoldReturnPct));
});
