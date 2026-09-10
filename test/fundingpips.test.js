import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, iso, CONFIG, configHash } from '../src/config.js';
import { validateMarket } from '../src/market.js';
import { createState } from '../src/engine.js';
import { protocol, validateResearchMarket } from '../src/fundingpips/data.js';
import { chooseFinalists, rankCandidate, finalAssessment } from '../src/fundingpips/study.js';
import { prepare, makeOrders, aggregateHours, entryAllowed, cutoff } from '../src/fundingpips/signals.js';
import { simulate, challenge, sizePosition, firmViolation, dailyFloor, platformDay, fillPrice, DAY } from '../src/fundingpips/engine.js';

const ZERO = { id: 'zero-fixture', feePerSide: 0, halfSpread: 0, slippagePerSide: 0 };
const BASE = protocol.costs[0];
const CANDIDATE = { id: 'fixture', riskRate: 0.0025 };
const START = Date.parse('2026-01-05T06:00:00.000Z');
function market(from = START, count = 32) {
  return Object.fromEntries(protocol.data.symbols.map((s) => [s, Array.from({ length: count }, (_, i) =>
    ({ time: iso(from + i * STEP), open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 }))]));
}
function order(time = START, overrides = {}) {
  return { symbol: 'BTC-USD', direction: 1, signalTime: iso(time), close: 100, atr: 100,
    stop: 99, rewardRisk: 2, maxHoldHours: 4, ...overrides };
}
function run(m, orders = new Map([[START, [order()]]]), extra = {}) {
  return simulate({ market: m, orders, candidate: CANDIDATE, from: Date.parse(m['BTC-USD'][0].time),
    to: Date.parse(m['BTC-USD'].at(-1).time) + STEP, costs: ZERO, ...extra });
}

test('current-rule daily high baseline, static touch and fixed UTC+3 reset through DST dates', () => {
  assert.equal(dailyFloor(5000, 5200), 4940);
  assert.equal(dailyFloor(5200, 5000), 4940);
  assert.equal(firmViolation(5000, 4940, 4940), 'daily-loss');
  assert.equal(firmViolation(4500, 5200, 4000), 'overall-loss');
  assert.equal(firmViolation(5200, 4500, 4000), 'overall-loss');
  for (const date of ['2026-01-05', '2026-03-29', '2026-10-25']) {
    assert.equal(platformDay(Date.parse(`${date}T20:59:59Z`)), date);
    assert.notEqual(platformDay(Date.parse(`${date}T21:00:00Z`)), date);
  }
});

test('long and short accounting charge fees and adverse fills both ways; cost-aware risk and net margin', () => {
  for (const direction of [1, -1]) {
    const m = market();
    const result = run(m, new Map([[START, [order(START, { direction, stop: direction === 1 ? 99 : 101 })]]]), { costs: BASE });
    const t = result.trades[0];
    assert.ok(t.netPnl < 0);
    assert.equal(t.entryPrice, fillPrice(100, direction, true, BASE));
    assert.equal(t.exitPrice, fillPrice(100, direction, false, BASE));
    assert.ok(Math.abs(result.metrics.endingBalance - 5000 - t.netPnl) < 1e-8);
    assert.ok(t.freeMarginAtEntry > 0);
    assert.ok(t.quantity * t.entryPrice <= 5000 * 1.8);
    const exitStop = fillPrice(t.stop, direction, false, BASE);
    const risk = t.quantity * (direction * (t.entryPrice - exitStop) + BASE.feePerSide * (t.entryPrice + exitStop));
    assert.ok(risk <= 12.5 + 1e-8);
  }
  const tight = order(START, { stop: 99.999 });
  const evalSize = sizePosition(5000, tight, 100, 0.0025, BASE, 2);
  const masterSize = sizePosition(5000, tight, 100, 0.0025, BASE, 1);
  assert.ok(masterSize < evalSize);
  assert.ok(masterSize * 100 < 4500);
});

test('same-bar stop beats target and opening gap stop retains adverse fill', () => {
  const m = market();
  Object.assign(m['BTC-USD'][0], { low: 98, high: 103 });
  const a = run(m);
  assert.equal(a.trades[0].reason, 'stop-first');
  assert.equal(a.trades[0].exitMid, 99);
  const n = market();
  Object.assign(n['BTC-USD'][1], { open: 97, low: 96, high: 100, close: 99 });
  const b = run(n);
  assert.equal(b.trades[0].reason, 'gap-stop');
  assert.equal(b.trades[0].exitMid, 97);
});

test('intrabar drawdown includes unfavorable path but does not count post-stop extrema', () => {
  const m = market();
  Object.assign(m['BTC-USD'][0], { low: 50, high: 103 });
  const result = run(m);
  assert.ok(result.metrics.maxIntrabarDrawdownPct < 2);
  assert.ok(result.metrics.maxIntrabarDrawdownPct > result.metrics.maxCloseDrawdownPct);
  assert.equal(result.trades[0].exitMid, 99);
});

test('failure before recovery halts account, never nets later winners or trades to pass', () => {
  const m = market();
  Object.assign(m['BTC-USD'][1], { open: 40, high: 200, low: 40, close: 150 });
  const result = run(m, new Map([[START, [order()]], [START + 2 * STEP, [order(START + 2 * STEP)]]]),
    { mode: 'challenge', target: 0.08 });
  assert.equal(result.metrics.status, 'breach');
  assert.equal(result.metrics.reason, 'overall-loss');
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitMid, 40);
  assert.ok(result.metrics.endingBalance < 4500);
});

test('internal daily guard is below firm floor; internal stop is not mislabeled a firm breach', () => {
  const m = market();
  Object.assign(m['BTC-USD'][1], { open: 95, high: 100, low: 95, close: 100 });
  const result = run(m, undefined, { mode: 'managed' });
  assert.equal(result.metrics.status, 'running');
  assert.ok(result.metrics.riskEvents.some((e) => e.reason === 'internal-daily-stop'));
  assert.equal(result.trades[0].reason, 'internal-daily-stop');
  assert.equal(result.trades[0].exitMid, 95);
});

test('minimum three entry days and flat realized target, not floating or terminal magic', () => {
  const m = market(START, 220);
  const times = [START, START + DAY, START + 2 * DAY];
  const orders = new Map(times.map((t) => [t, [order(t)]]));
  for (const t of times) m['BTC-USD'][(t - START) / STEP].high = 103;
  const result = run(m, orders, { mode: 'challenge', target: 0.004 });
  assert.equal(result.metrics.status, 'target');
  assert.equal(result.trades.length, 3);
  assert.equal(result.metrics.entryTradingDays, 3);
  assert.ok(Date.parse(result.metrics.stoppedAt) > times[2]);
  const one = run(m, new Map([[START, [order()]]]), { mode: 'challenge', target: 0.004 });
  assert.notEqual(one.metrics.status, 'target');
});

test('sequential phases reset $5000 and never reuse prior phase time', () => {
  const from = Date.parse('2026-01-05T00:00:00.000Z');
  const m = market(from, 25 * 96), orders = new Map();
  for (let i = 0; i < m['BTC-USD'].length; i++) {
    const t = from + i * STEP;
    if (entryAllowed(t) && new Date(t).getUTCHours() === 6 && new Date(t).getUTCMinutes() === 0) {
      orders.set(t, [order(t, { rewardRisk: 10 })]);
      m['BTC-USD'][i].high = 111;
    }
  }
  const result = challenge({ market: m, orders, candidate: CANDIDATE, from, dataEnd: from + 25 * DAY, horizonDays: 20, costs: ZERO });
  assert.equal(result.outcome, 'pass');
  assert.ok(result.phase1.entryTradingDays >= 3);
  assert.ok(result.phase2.entryTradingDays >= 3);
  assert.equal(result.phase2.initial, 5000);
  assert.ok(Date.parse(result.phase2.from) > Date.parse(result.phase1.stoppedAt));
  assert.ok(result.ledgers.phase2.every((t) => Date.parse(t.entryTime) > Date.parse(result.phase1.stoppedAt)));
});

test('30 days no completed trade is inactivity; horizon pending differs from right censorship', () => {
  const m = market(START, 40 * 96);
  const noOrders = new Map();
  const result = run(m, noOrders, { mode: 'challenge', target: 0.08 });
  assert.equal(result.metrics.status, 'inactivity');
  assert.equal(Date.parse(result.metrics.stoppedAt), START + 30 * DAY);
  const common = { market: m, orders: noOrders, candidate: CANDIDATE, from: START, costs: ZERO };
  assert.equal(challenge({ ...common, dataEnd: START + 10 * DAY, horizonDays: 20 }).outcome, 'censored');
  assert.equal(challenge({ ...common, dataEnd: START + 40 * DAY, horizonDays: 20 }).outcome, 'pending');
});

test('closed-hour signals, warmup and prefix invariance forbid lookahead', () => {
  const from = Date.parse('2024-01-01T00:00:00.000Z'), m = market(from, 450 * 4);
  for (const symbol of protocol.data.symbols) {
    for (let i = 0; i < m[symbol].length; i++) {
      const price = 100 + i * 0.03;
      Object.assign(m[symbol][i], { open: price, close: price + 0.02, high: price + 0.025, low: price - 0.01 });
    }
  }
  const c = protocol.candidates[0], orders = makeOrders(prepare(m), c);
  assert.ok(orders.size > 0);
  assert.ok([...orders.keys()].every((t) => (t - from) / 3600000 >= 337 && t % 3600000 === 0));
  const boundary = from + 420 * 3600000;
  const prefix = Object.fromEntries(Object.entries(m).map(([s, b]) => [s, b.filter((bar) => Date.parse(bar.time) < boundary)]));
  const prefixOrders = makeOrders(prepare(prefix), c);
  assert.deepEqual([...prefixOrders], [...orders].filter(([t]) => t <= boundary));
  const hours = aggregateHours(m['BTC-USD']);
  assert.equal(hours[0].close, m['BTC-USD'][3].close);
  assert.equal(hours[0].open, m['BTC-USD'][0].open);
});

test('missing/stale/invalid data rejected; weekday session never crosses modeled rollover', () => {
  const m = market();
  m['BTC-USD'].splice(2, 1);
  assert.throws(() => validateMarket(m), /Missing/);
  assert.throws(() => prepare(m), /Missing/);
  assert.throws(() => validateMarket(market(), { now: START }), /future/);
  assert.equal(entryAllowed(Date.parse('2026-01-10T10:00:00Z')), false);
  assert.equal(entryAllowed(Date.parse('2026-01-09T14:00:00Z')), false);
  assert.equal(iso(cutoff(Date.parse('2026-01-09T10:00:00Z'))), '2026-01-09T16:00:00.000Z');
});

test('research neither modifies frozen original parameters nor creates a live account', () => {
  const original = createState('2026-01-01T00:00:00.000Z');
  const before = structuredClone(original), beforeHash = configHash(CONFIG);
  run(market());
  assert.deepEqual(original, before);
  assert.equal(configHash(CONFIG), beforeHash);
  assert.equal(original.startingBalance, 10000);
  assert.equal(original.id, 'PAPER-001');
  assert.equal(protocol.candidates.length, 16);
});

test('causal gaps retain prior entries, restart full warmup and preserve unresolved open inventory', () => {
  const from = Date.parse('2024-01-01T00:00:00.000Z');
  const m = market(from, 800 * 4);
  for (const symbol of protocol.data.symbols) {
    m[symbol].forEach((b, i) => {
      const price = 100 + i * 0.03;
      Object.assign(b, { open: price, close: price + 0.02, high: price + 0.025, low: price - 0.01 });
    });
    m[symbol].splice(400 * 4 + 1, 1);
  }
  validateResearchMarket(m);
  const features = prepare(m, { allowGaps: true });
  const gap = from + (400 * 4 + 1) * STEP;
  const orders = makeOrders(features, protocol.candidates[0]);
  assert.ok(features.excludedDays.has(iso(gap).slice(0, 10)));
  assert.ok([...orders.keys()].some((t) => t < gap && iso(t).slice(0, 10) === iso(gap).slice(0, 10)));
  assert.ok([...orders.keys()].filter((t) => t > gap).every((t) => t >= gap + 336 * 3600000));
  const broken = market();
  for (const s of protocol.data.symbols) broken[s].splice(1, 1);
  const result = run(broken);
  assert.equal(result.metrics.status, 'data-indeterminate');
  assert.equal(result.metrics.complete, false);
  assert.equal(result.trades.length, 0);
  assert.ok(result.metrics.unresolvedPosition.quantity > 0);
  assert.equal(result.metrics.unresolvedPosition.entered, START);
  const cohort = challenge({ market: broken, orders: new Map([[START, [order()]]]), candidate: CANDIDATE,
    from: START, dataEnd: START + 32 * STEP, horizonDays: 60, costs: ZERO });
  assert.equal(cohort.outcome, 'data-indeterminate');
  const duplicate = market();
  for (const s of protocol.data.symbols) duplicate[s][1].time = duplicate[s][0].time;
  assert.throws(() => validateResearchMarket(duplicate), /Duplicate/);
});

test('baseline remains fixed despite intraday profits and precise targets depend on net fees', () => {
  const m = market();
  m['BTC-USD'][0].high = 103;
  const result = run(m, undefined, { costs: BASE, mode: 'challenge', target: 0.08 });
  assert.ok(result.metrics.netPnl > 0);
  assert.equal(result.daily[0].baseline, 5000);
  assert.equal(result.daily[0].floor, 4750);
  assert.ok(result.metrics.netPnl < 25);
  assert.notEqual(result.metrics.status, 'target');
});

test('an adverse short gap is preserved and intrabar internal breach is labeled possible, not tick proof', () => {
  const m = market();
  Object.assign(m['BTC-USD'][1], { open: 105, high: 106, low: 100, close: 100 });
  const result = run(m, new Map([[START, [order(START, { direction: -1, stop: 101 })]]]));
  assert.equal(result.trades[0].exitMid, 105);
  assert.equal(result.trades[0].reason, 'gap-stop');
  assert.ok(result.trades[0].netPnl < 0);
  const long = market(START, 64);
  const orders = new Map();
  for (let i = 0; i < 8; i++) {
    const t = START + i * STEP;
    orders.set(t, [order(t)]);
    Object.assign(long['BTC-USD'][i], { high: 101, low: 98.5 });
  }
  const managed = run(long, orders, { mode: 'managed' });
  assert.ok(managed.metrics.riskEvents.some((e) => e.certainty === 'possible-intrabar-bound-not-tick-proof'));
  assert.ok(managed.trades.length < 8);
});

test('selection gates and ranking use development only; distinct families and lexical ties deterministic', () => {
  const metric = { from: '2025-07-01T00:00:00Z', to: '2026-01-01T00:00:00Z', netReturnPct: 2,
    profitFactor: 1.2, tradeCount: 120, maxIntrabarDrawdownPct: 2 };
  const run = { metrics: metric, daily: [{ day: '2025-08-01', netPnl: 10 }, { day: '2025-11-01', netPnl: 10 }] };
  const runs = { training: run, validation: run, validationDouble: run, managedTraining: run, managedValidation: run };
  const ranked = protocol.candidates.map((candidate) => rankCandidate(candidate, runs));
  assert.ok(ranked.every((r) => r.eligible));
  const selected = chooseFinalists(ranked);
  assert.equal(selected.length, 2);
  assert.notEqual(selected[0].candidate.family, selected[1].candidate.family);
  const failed = rankCandidate(CANDIDATE, { ...runs, validationDouble: { ...run, metrics: { ...metric, netReturnPct: -1 } } });
  assert.equal(failed.eligible, false);
  assert.match(failed.rejectionReasons.join(' '), /Double-cost/);
  assert.match(finalAssessment({ eligible: true }, { complete: false, netReturnPct: 2, profitFactor: 1.2 }), /data-indeterminate/);
});

test('trailing missing bar cannot invent terminal exit before an unseen interval', () => {
  const m = market(START, 4);
  for (const symbol of protocol.data.symbols) m[symbol].splice(1, 1);
  const unresolved = run(m, undefined, { to: START + 2 * STEP });
  assert.equal(unresolved.trades.length, 0);
  assert.equal(unresolved.metrics.status, 'data-indeterminate');
  assert.equal(unresolved.metrics.complete, false);
  assert.equal(unresolved.metrics.unresolvedPosition.lastKnownTime, iso(START + STEP));
  const flat = run(m, new Map(), { to: START + 2 * STEP });
  assert.equal(flat.metrics.endingEquity, 5000);
  assert.equal(flat.metrics.to, iso(START + 2 * STEP));
});

test('reversion requires closing inside both bands; session breakout crosses from inside range', () => {
  const from = Date.parse('2026-01-05T00:00:00.000Z');
  const count = 345, hours = Array.from({ length: count }, (_, i) => ({
    time: iso(from + i * 3600000), open: 100, high: 102, low: 98, close: 100, volume: 1
  }));
  const group = {
    hours, fast: Array(count).fill(100), slow: Array(count).fill(100), volatility: Array(count).fill(2),
    bands: Array.from({ length: count }, () => ({ mean: 100, sigma: 1 }))
  };
  // Last signal is Monday 09:00, after the 336h warmup.
  hours[count - 2].close = 96; hours[count - 1].close = 104;
  const features = { 'BTC-USD': [group], 'ETH-USD': [], excludedDays: new Set() };
  const reversion = protocol.candidates.find((c) => c.family === 'reversion' && c.parameter === 2);
  const time = Date.parse(hours.at(-1).time) + 3600000;
  assert.equal(makeOrders(features, reversion).has(time), false);
  hours[count - 1].close = 99;
  assert.equal(makeOrders(features, reversion).has(time), true);
  const session = protocol.candidates.find((c) => c.family === 'session');
  hours[count - 2].close = 97; hours[count - 1].close = 103;
  assert.equal(makeOrders(features, session).has(time), false);
  hours[count - 2].close = 100;
  assert.equal(makeOrders(features, session).has(time), true);
});
