import { CONFIG, STEP, WARMUP, STARTING_BALANCE, configHash, hash, iso, round } from './config.js';
import { signals } from './indicators.js';
import { validateMarket } from './market.js';

const EPSILON = 0.00001;
const approximately = (a, b) => Math.abs(a - b) < EPSILON;
const day = (time) => time.slice(0, 10);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;

export function createState(createdAt = iso(Date.now()), config = CONFIG) {
  return {
    schemaVersion: 1, configHash: configHash(config), id: 'PAPER-001', createdAt,
    startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE, equity: STARTING_BALANCE,
    realizedPnl: 0, unrealizedPnl: 0, totalFees: 0, exposure: 0,
    peakEquity: STARTING_BALANCE, drawdownPct: 0, maxDrawdownPct: 0,
    day: null, dayStartEquity: STARTING_BALANCE, dayPnl: 0,
    paused: false, riskHalt: null, lastProcessed: null,
    positions: [], pending: [], fills: [], equityHistory: [], decisions: [], activity: [], market: []
  };
}

export function validateState(state, config = CONFIG) {
  if (!state || state.schemaVersion !== 1 || state.configHash !== configHash(config) || state.id !== 'PAPER-001') {
    throw new Error('Incompatible account schema or frozen parameters');
  }
  if (!validTime(state.createdAt) || (state.lastProcessed !== null && (!validTime(state.lastProcessed) || Date.parse(state.lastProcessed) % STEP))) {
    throw new Error('Invalid account timestamps');
  }
  if (state.startingBalance !== STARTING_BALANCE || typeof state.paused !== 'boolean' ||
      ![null, 'daily-loss', 'max-drawdown'].includes(state.riskHalt)) throw new Error('Invalid account controls');
  if (state.day !== null && (typeof state.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.day))) {
    throw new Error('Invalid UTC accounting day');
  }
  for (const field of ['cash', 'equity', 'realizedPnl', 'unrealizedPnl', 'totalFees', 'exposure', 'peakEquity',
    'drawdownPct', 'maxDrawdownPct', 'dayStartEquity', 'dayPnl']) {
    if (!finite(state[field])) throw new Error(`Invalid account ${field}`);
  }
  if (state.cash < -EPSILON || state.equity < -EPSILON || state.peakEquity < state.equity - EPSILON) throw new Error('Negative cash or invalid equity peak');
  for (const field of ['positions', 'pending', 'fills', 'equityHistory', 'decisions', 'activity', 'market']) {
    if (!Array.isArray(state[field])) throw new Error(`Invalid account ${field}`);
  }
  let cash = STARTING_BALANCE, fees = 0, realized = 0, previousHash = null, previousTime = '';
  const open = new Map();
  const ids = new Set();
  for (const fill of state.fills) {
    const { hash: digest, ...record } = fill;
    if (fill.prevHash !== previousHash || hash(record) !== digest) throw new Error('Fill audit hash chain is broken');
    if (ids.has(fill.id) || !config.symbols.includes(fill.symbol) || !validTime(fill.time) || fill.time < previousTime ||
        !['BUY', 'SELL'].includes(fill.side) || fill.id !== `${fill.positionId}:${fill.side}` ||
        !finite(fill.quantity) || fill.quantity <= 0 ||
        !finite(fill.price) || fill.price <= 0 || !finite(fill.fee) || fill.fee < 0 || !finite(fill.realizedPnl)) {
      throw new Error('Invalid or duplicate fill');
    }
    if (!approximately(fill.fee, round(fill.quantity * fill.price * config.feeRate))) throw new Error('Fill fee mismatch');
    ids.add(fill.id);
    fees += fill.fee;
    previousTime = fill.time;
    previousHash = digest;
    if (fill.side === 'BUY') {
      if (open.has(fill.positionId) || fill.realizedPnl !== 0 || fill.positionId !== `${fill.symbol}:${fill.time}`) throw new Error('Invalid entry ledger');
      open.set(fill.positionId, fill);
      cash -= fill.quantity * fill.price + fill.fee;
    } else {
      const entry = open.get(fill.positionId);
      if (!entry || entry.symbol !== fill.symbol || entry.quantity !== fill.quantity) throw new Error('Exit does not match an entry');
      const pnl = fill.quantity * (fill.price - entry.price) - entry.fee - fill.fee;
      if (!approximately(pnl, fill.realizedPnl)) throw new Error('Realized P&L does not reconcile');
      realized += fill.realizedPnl;
      cash += fill.quantity * fill.price - fill.fee;
      open.delete(fill.positionId);
    }
    if (cash < -EPSILON) throw new Error('Ledger overspends available cash');
  }
  if (!approximately(state.cash, cash) || !approximately(state.totalFees, fees) || !approximately(state.realizedPnl, realized)) {
    throw new Error('Cash, fees, or realized P&L ledger reconciliation failed');
  }
  if (state.positions.length !== open.size || state.positions.length > config.maxPositions) throw new Error('Position ledger mismatch');
  let exposure = 0, unrealized = 0;
  const symbols = new Set();
  for (const position of state.positions) {
    const entry = open.get(position.id);
    if (!entry || symbols.has(position.symbol) || entry.symbol !== position.symbol || entry.price !== position.entryPrice ||
        entry.quantity !== position.quantity || entry.fee !== position.entryFee || entry.time !== position.entryTime ||
        !finite(position.markPrice) || position.markPrice <= 0 || !finite(position.stop) || position.stop <= 0 ||
        !finite(position.target) || position.target <= position.entryPrice || position.stop >= position.entryPrice) {
      throw new Error('Invalid open position');
    }
    symbols.add(position.symbol);
    exposure += position.quantity * position.markPrice;
    const pnl = position.quantity * (position.markPrice - position.entryPrice) - position.entryFee;
    if (!approximately(pnl, position.unrealizedPnl)) throw new Error('Position P&L mismatch');
    unrealized += pnl;
  }
  if (!approximately(state.exposure, exposure) || !approximately(state.equity, state.cash + exposure) ||
      !approximately(state.unrealizedPnl, unrealized) ||
      !approximately(state.equity - STARTING_BALANCE, state.realizedPnl + state.unrealizedPnl)) {
    throw new Error('Equity reconciliation failed');
  }
  const pendingSymbols = new Set();
  for (const order of state.pending) {
    if (!config.symbols.includes(order.symbol) || pendingSymbols.has(order.symbol) || !validTime(order.time) ||
        order.time !== state.lastProcessed || !finite(order.stop) || order.stop <= 0 ||
        !finite(order.close) || !finite(order.atr) || order.atr <= 0 || order.stop >= order.close) throw new Error('Invalid pending setup');
    pendingSymbols.add(order.symbol);
  }
  let lastPoint = '';
  let peak = STARTING_BALANCE, maxDd = 0;
  for (const point of state.equityHistory) {
    if (!validTime(point.time) || point.time <= lastPoint || !finite(point.equity) || point.equity < 0 ||
        !finite(point.cash) || point.cash < -EPSILON || point.cash > point.equity + EPSILON || !finite(point.drawdownPct)) {
      throw new Error('Invalid equity history');
    }
    lastPoint = point.time;
    peak = Math.max(peak, point.equity);
    const dd = (peak - point.equity) / peak * 100;
    if (!approximately(dd, point.drawdownPct)) throw new Error('Equity drawdown history mismatch');
    maxDd = Math.max(maxDd, dd);
  }
  if (state.equityHistory.length) {
    const last = state.equityHistory.at(-1);
    if (!approximately(last.equity, state.equity) || !approximately(last.cash, state.cash) ||
        !approximately(peak, state.peakEquity) || !approximately(maxDd, state.maxDrawdownPct) ||
        !approximately(last.drawdownPct, state.drawdownPct) ||
        !state.lastProcessed || last.time !== iso(Date.parse(state.lastProcessed) + STEP) ||
        (previousTime && previousTime > last.time)) throw new Error('Equity history does not reconcile');
    const dayBoundary = `${state.day}T00:00:00.000Z`;
    const dayBaseline = state.equityHistory.findLast((point) => point.time <= dayBoundary)?.equity ?? STARTING_BALANCE;
    if (!approximately(state.dayStartEquity, dayBaseline) || !approximately(state.dayPnl, state.equity - dayBaseline)) {
      throw new Error('Daily equity baseline does not reconcile');
    }
    if (state.market.length !== config.symbols.length || state.market.some((item, i) =>
      item.symbol !== config.symbols[i] || item.asOf !== last.time || !finite(item.price) || item.price <= 0 ||
      !finite(item.emaFast) || !finite(item.emaSlow) || !finite(item.atr) || item.atr < 0)) {
      throw new Error('Invalid persisted market marks');
    }
  } else if (state.lastProcessed !== null || state.fills.length || state.positions.length || state.pending.length ||
      state.market.length || state.equity !== STARTING_BALANCE || state.peakEquity !== STARTING_BALANCE ||
      state.dayStartEquity !== STARTING_BALANCE || state.dayPnl !== 0 || state.drawdownPct !== 0 || state.maxDrawdownPct !== 0) {
    throw new Error('Uninitialized account contains trading history');
  }
  return state;
}

export function activity(state, time, message, level = 'info') {
  state.activity.push({ time, level, message });
  state.activity = state.activity.slice(-500);
}

export function applyControl(state, control, time) {
  if (!['evaluate', 'pause', 'resume'].includes(control)) throw new Error('Unknown account control');
  if (control === 'evaluate') return;
  state.paused = control === 'pause';
  state.pending = [];
  activity(state, time, state.paused
    ? 'Paused new entries. Existing positions retain stops, targets, 4-hour and UTC session exits.'
    : 'New entries resumed. Risk circuit breakers remain in force.');
}

function recordFill(state, fill) {
  const record = { ...fill, prevHash: state.fills.at(-1)?.hash ?? null };
  state.fills.push({ ...record, hash: hash(record) });
  state.totalFees = round(state.totalFees + fill.fee);
}

function closePosition(state, position, basePrice, time, reason, config) {
  const price = round(basePrice * (1 - config.slippageRate));
  const fee = round(position.quantity * price * config.feeRate);
  const realizedPnl = round(position.quantity * (price - position.entryPrice) - position.entryFee - fee);
  state.cash = round(state.cash + position.quantity * price - fee);
  state.realizedPnl = round(state.realizedPnl + realizedPnl);
  recordFill(state, {
    id: `${position.id}:SELL`, positionId: position.id, time, symbol: position.symbol, side: 'SELL',
    quantity: position.quantity, price, fee, reason, realizedPnl
  });
  state.positions = state.positions.filter((p) => p.id !== position.id);
  activity(state, time, `${position.symbol} simulated exit: ${reason}; net P&L $${realizedPnl.toFixed(2)}`);
}

function mark(state, bars) {
  for (const position of state.positions) {
    position.markPrice = bars[position.symbol].close;
    position.unrealizedPnl = round(position.quantity * (position.markPrice - position.entryPrice) - position.entryFee);
  }
  state.exposure = round(state.positions.reduce((sum, p) => sum + p.quantity * p.markPrice, 0));
  state.unrealizedPnl = round(state.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0));
  state.equity = round(state.cash + state.exposure);
  state.dayPnl = round(state.equity - state.dayStartEquity);
}

export function positionSize(state, order, open, config = CONFIG) {
  const price = round(open * (1 + config.slippageRate));
  const stopExit = order.stop * (1 - config.slippageRate);
  const riskPerUnit = price - stopExit + price * config.feeRate + stopExit * config.feeRate;
  if (order.stop <= 0 || price <= order.stop || riskPerUnit <= 0) return 0;
  const notional = Math.min(
    state.equity * config.maxPositionExposure,
    Math.max(0, state.equity * config.maxExposure - state.exposure),
    state.cash / (1 + config.feeRate)
  );
  return Math.floor(Math.max(0, Math.min(state.equity * config.riskPerTrade / riskPerUnit, notional / price)) * 1e8) / 1e8;
}

function riskReason(state, config) {
  if (state.riskHalt === 'max-drawdown' || (state.peakEquity - state.equity) / state.peakEquity >= config.maxDrawdown) return 'max-drawdown';
  if (state.riskHalt === 'daily-loss' || state.dayPnl <= -state.dayStartEquity * config.dailyLossLimit) return 'daily-loss';
  return null;
}

function enforceOpeningRisk(state, openingBars, time, config) {
  mark(state, openingBars);
  const halt = riskReason(state, config);
  if (!halt) return;
  if (state.riskHalt !== halt) activity(state, time, `Risk circuit breaker: ${halt}`, 'warning');
  state.riskHalt = halt;
  for (const position of [...state.positions]) {
    closePosition(state, position, openingBars[position.symbol].close, time, halt, config);
  }
  mark(state, openingBars);
}

function executeBar(state, bars, setups, config) {
  const time = bars[config.symbols[0]].time;
  const closeTime = iso(Date.parse(time) + STEP);
  if (state.day !== day(time)) {
    state.day = day(time);
    state.dayStartEquity = state.equity;
    state.dayPnl = 0;
    if (state.riskHalt === 'daily-loss') state.riskHalt = null;
  }
  // Use only opening marks to size new entries, never this bar's future high/low/close.
  const openingBars = Object.fromEntries(config.symbols.map((symbol) => [symbol, { close: bars[symbol].open }]));
  mark(state, openingBars);
  const openingHalt = riskReason(state, config);
  if (openingHalt) state.riskHalt = openingHalt;
  for (const position of [...state.positions]) {
    const bar = bars[position.symbol];
    if (bar.open <= position.stop) closePosition(state, position, bar.open, time, 'gap-stop', config);
    else if (bar.open >= position.target) closePosition(state, position, position.target, time, 'gap-target', config);
    else if (state.riskHalt) closePosition(state, position, bar.open, time, state.riskHalt, config);
  }
  // Exit costs can cross a guard even when pre-exit marked equity did not.
  enforceOpeningRisk(state, openingBars, time, config);
  for (const order of state.pending) {
    const blocked = state.paused ? 'paused' : state.riskHalt ?? (
      state.positions.length >= config.maxPositions ? 'maximum positions' :
        state.positions.some((p) => p.symbol === order.symbol) ? 'already holding this asset' :
          Date.parse(order.time) + STEP !== Date.parse(time) || day(order.time) !== day(time) ? 'expired setup' : null
    );
    if (blocked) {
      activity(state, time, `${order.symbol} setup skipped: ${blocked}`);
      continue;
    }
    const bar = bars[order.symbol];
    if (bar.open <= order.stop || Math.abs(bar.open - order.close) > order.atr) {
      activity(state, time, `${order.symbol} setup skipped: opening gap outside allowed range`);
      continue;
    }
    const quantity = positionSize(state, order, bar.open, config);
    if (quantity <= 0) {
      activity(state, time, `${order.symbol} setup skipped: risk/cash/exposure capacity exhausted`);
      continue;
    }
    const entryPrice = round(bar.open * (1 + config.slippageRate));
    const entryFee = round(quantity * entryPrice * config.feeRate);
    const id = `${order.symbol}:${time}`;
    const position = {
      id, symbol: order.symbol, quantity, entryPrice, entryTime: time, stop: order.stop,
      target: round(entryPrice + config.targetR * (entryPrice - order.stop)), entryFee,
      markPrice: bar.open, unrealizedPnl: 0
    };
    state.positions.push(position);
    state.cash = round(state.cash - quantity * entryPrice - entryFee);
    recordFill(state, {
      id: `${id}:BUY`, positionId: id, time, symbol: order.symbol, side: 'BUY',
      quantity, price: entryPrice, fee: entryFee, reason: 'prior-closed-bar-breakout', realizedPnl: 0
    });
    mark(state, openingBars);
    activity(state, time, `${order.symbol} simulated entry at next bar open (fees and adverse slippage included)`);
    enforceOpeningRisk(state, openingBars, time, config);
  }
  state.pending = [];
  // OHLC cannot reveal intrabar order: if both levels are touched, the stop always wins.
  for (const position of [...state.positions]) {
    const bar = bars[position.symbol];
    if (bar.low <= position.stop) closePosition(state, position, position.stop, closeTime, 'stop', config);
    else if (bar.high >= position.target) closePosition(state, position, position.target, closeTime, 'target', config);
    else if (Date.parse(closeTime) - Date.parse(position.entryTime) >= config.maxHoldBars * STEP) {
      closePosition(state, position, bar.close, closeTime, 'max-hold', config);
    } else if (day(closeTime) !== day(time)) closePosition(state, position, bar.close, closeTime, 'UTC-session-end', config);
  }
  mark(state, bars);
  const halt = riskReason(state, config);
  if (halt) {
    if (state.riskHalt !== halt) activity(state, closeTime, `Risk circuit breaker: ${halt}`, 'warning');
    state.riskHalt = halt;
    for (const position of [...state.positions]) closePosition(state, position, bars[position.symbol].close, closeTime, halt, config);
    mark(state, bars);
  }
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  state.drawdownPct = (state.peakEquity - state.equity) / state.peakEquity * 100;
  state.maxDrawdownPct = Math.max(state.maxDrawdownPct, state.drawdownPct);
  state.equityHistory.push({ time: closeTime, equity: state.equity, cash: state.cash, drawdownPct: state.drawdownPct });
  for (const symbol of config.symbols) {
    const setup = setups[symbol];
    const blocked = state.paused ? 'Account paused' : state.riskHalt ? `Risk halt: ${state.riskHalt}` :
      day(closeTime) !== day(time) ? 'UTC session ended' : null;
    state.decisions.push({ time: closeTime, symbol, signal: blocked ? 'BLOCKED' : setup.signal, reason: blocked ?? setup.reason });
    if (!blocked && setup.signal === 'BUY SETUP' && !state.positions.some((p) => p.symbol === symbol)) {
      state.pending.push({ symbol, time, close: setup.close, atr: setup.atr, stop: setup.stop });
    }
  }
  state.decisions = state.decisions.slice(-2000);
  state.market = config.symbols.map((symbol) => ({
    symbol, price: bars[symbol].close, asOf: closeTime, signal: setups[symbol].signal,
    emaFast: setups[symbol].emaFast, emaSlow: setups[symbol].emaSlow, atr: setups[symbol].atr
  }));
  state.lastProcessed = time;
}

export function processMarket(inputState, market, { config = CONFIG, now = Date.now(), fresh = false, startTime } = {}) {
  validateState(inputState, config);
  validateMarket(market, { config, now, fresh });
  const state = structuredClone(inputState);
  const reference = market[config.symbols[0]];
  if (!state.lastProcessed && reference.length <= WARMUP) throw new Error('Insufficient indicator warmup (150 prior bars required)');
  const calculated = Object.fromEntries(config.symbols.map((symbol) => [symbol, signals(market[symbol], config)]));
  const firstIndex = state.lastProcessed
    ? reference.findIndex((bar) => Date.parse(bar.time) > Date.parse(state.lastProcessed))
    : reference.findIndex((bar) => Date.parse(bar.time) >= (startTime ?? Date.parse(reference[WARMUP]?.time)));
  if (firstIndex === -1) return state;
  if (firstIndex < WARMUP) throw new Error('Insufficient indicator warmup (150 prior bars required)');
  if (state.lastProcessed && Date.parse(reference[firstIndex].time) !== Date.parse(state.lastProcessed) + STEP) {
    throw new Error('Account replay has a missing bar');
  }
  for (let i = firstIndex; i < reference.length; i++) {
    executeBar(state,
      Object.fromEntries(config.symbols.map((symbol) => [symbol, market[symbol][i]])),
      Object.fromEntries(config.symbols.map((symbol) => [symbol, calculated[symbol][i]])), config);
  }
  return validateState(state, config);
}

export function initializeForward(state, market, now = Date.now()) {
  validateState(state);
  validateMarket(market, { fresh: true, now });
  if (state.lastProcessed !== null || state.fills.length || state.positions.length) throw new Error('Cannot reinitialize an existing account');
  const lastIndex = market[CONFIG.symbols[0]].length - 1;
  if (lastIndex < WARMUP) throw new Error('Insufficient initialization warmup');
  const result = structuredClone(state);
  result.lastProcessed = market[CONFIG.symbols[0]][lastIndex].time;
  const closeTime = iso(Date.parse(result.lastProcessed) + STEP);
  result.day = day(closeTime);
  result.equityHistory.push({ time: closeTime, equity: STARTING_BALANCE, cash: STARTING_BALANCE, drawdownPct: 0 });
  result.market = CONFIG.symbols.map((symbol) => {
    const setup = signals(market[symbol], CONFIG).at(-1);
    return { symbol, price: setup.close, asOf: closeTime, signal: 'WAIT', emaFast: setup.emaFast, emaSlow: setup.emaSlow, atr: setup.atr };
  });
  activity(result, iso(now), 'New $10,000 virtual account initialized. Historical warmup generated no trades or profits.');
  return validateState(result);
}

export function liquidateBacktest(state, market, config = CONFIG) {
  const bars = Object.fromEntries(config.symbols.map((symbol) => [symbol, market[symbol].at(-1)]));
  const time = iso(Date.parse(state.lastProcessed) + STEP);
  for (const position of [...state.positions]) closePosition(state, position, bars[position.symbol].close, time, 'research-window-end', config);
  state.pending = [];
  mark(state, bars);
  // Replace the terminal close mark with its cost-inclusive liquidation value.
  state.equityHistory.pop();
  state.peakEquity = Math.max(STARTING_BALANCE, ...state.equityHistory.map((p) => p.equity), state.equity);
  state.drawdownPct = (state.peakEquity - state.equity) / state.peakEquity * 100;
  state.maxDrawdownPct = Math.max(0, ...state.equityHistory.map((p) => p.drawdownPct), state.drawdownPct);
  state.equityHistory.push({ time, equity: state.equity, cash: state.cash, drawdownPct: state.drawdownPct });
  return validateState(state, config);
}
