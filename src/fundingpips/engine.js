import { STEP, iso } from '../config.js';
import { protocol } from './data.js';
import { entryAllowed, cutoff } from './signals.js';

export const DAY = 86400000;
export const platformDay = (time) => iso(time + protocol.account.platformOffsetHours * 3600000).slice(0, 10);
export const dailyFloor = (balance, equity) => Math.max(balance, equity) * (1 - protocol.account.dailyLoss);
export function firmViolation(balance, equity, floor, initial = 5000) {
  if (Math.min(balance, equity) <= initial * (1 - protocol.account.overallLoss)) return 'overall-loss';
  if (Math.min(balance, equity) <= floor) return 'daily-loss';
  return null;
}
export const fillPrice = (mid, direction, entering, costs) =>
  mid * (1 + direction * (entering ? 1 : -1) * (costs.halfSpread + costs.slippagePerSide));

export function sizePosition(balance, order, open, riskRate, costs, leverage = 2, initial = 5000) {
  const entry = fillPrice(open, order.direction, true, costs);
  const stopExit = fillPrice(order.stop, order.direction, false, costs);
  const riskPerUnit = order.direction * (entry - stopExit) + costs.feePerSide * (entry + stopExit);
  if (!(order.stop > 0) || order.direction * (entry - order.stop) <= 0 || !(riskPerUnit > 0)) return 0;
  const mark = fillPrice(open, order.direction, false, costs);
  const openingLoss = order.direction * (entry - mark) + costs.feePerSide * (entry + mark);
  const budget = riskRate * Math.min(initial, balance);
  const affordable = 0.9 * balance / (entry / leverage + openingLoss);
  return Math.floor(Math.max(0, Math.min(budget / riskPerUnit, affordable)) * 1e8) / 1e8;
}

function stats(trades, daily, state, from, to, exposureBars, bars, peakExposure, grossExposure) {
  const wins = trades.filter((t) => t.netPnl > 0), losses = trades.filter((t) => t.netPnl < 0);
  const profit = wins.reduce((s, t) => s + t.netPnl, 0), loss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const turnover = trades.reduce((s, t) => s + t.quantity * (t.entryPrice + t.exitPrice), 0);
  const midTurnover = trades.reduce((s, t) => s + t.quantity * (t.entryMid + t.exitMid), 0);
  const grossPnl = trades.reduce((s, t) => s + t.grossMidPnl, 0);
  let streak = 0, maxStreak = 0;
  for (const trade of trades) { streak = trade.netPnl < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  return {
    from: iso(from), to: iso(to), initial: state.initial, endingBalance: state.balance, endingEquity: state.finalEquity,
    netPnl: state.finalEquity - state.initial, netReturnPct: (state.finalEquity / state.initial - 1) * 100,
    profitFactor: loss ? profit / loss : null, expectancy: trades.length ? (profit - loss) / trades.length : null,
    tradeCount: trades.length, winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    longTrades: trades.filter((t) => t.direction === 1).length, shortTrades: trades.filter((t) => t.direction === -1).length,
    totalFees: trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0) + (state.position?.entryFee ?? 0),
    spreadSlippage: trades.reduce((s, t) => s + t.spreadSlippage, 0),
    turnover, turnoverMultiple: turnover / state.initial,
    grossMidPnl: grossPnl, breakEvenAllInBpsPerSide: midTurnover ? grossPnl / midTurnover * 10000 : null,
    maxCloseDrawdownPct: state.maxCloseDd, maxIntrabarDrawdownPct: state.maxIntrabarDd,
    worstDayPnl: daily.length ? Math.min(...daily.map((d) => d.netPnl)) : 0,
    worstDayPct: daily.length ? Math.min(...daily.map((d) => d.netPnl / d.startEquity * 100)) : 0,
    maxLosingStreak: maxStreak, exposureTimePct: bars ? exposureBars / bars * 100 : 0,
    maxExposurePct: peakExposure, meanExposurePct: bars ? grossExposure / bars : 0,
    status: state.status, reason: state.reason, stoppedAt: state.stoppedAt,
    entryTradingDays: state.tradeDays.size, completedTradingDays: new Set(trades.map((t) => platformDay(Date.parse(t.exitTime)))).size,
    riskEvents: state.events, barPath: 'Conservative OHLC bound, not observed tick chronology',
    complete: state.status !== 'data-indeterminate',
    unresolvedPosition: state.unresolvedPosition ?? null,
    endpointMeaning: state.status === 'data-indeterminate' ? 'Last-known marked prefix ONLY; unresolved position, not a full-period realized return' : 'Flat, net realized endpoint'
  };
}

export function simulate({ market, orders, candidate, from, to, costs = protocol.costs[0],
  mode = 'economic', leverage = 2, target = null, initial = protocol.account.initial }) {
  if (!(to > from) || from % STEP || to % STEP || !Number.isFinite(candidate.riskRate) || candidate.riskRate <= 0 ||
    candidate.riskRate > 0.005 || !['economic', 'managed', 'challenge'].includes(mode) || ![1, 2].includes(leverage)) {
    throw new Error('Invalid research simulation arguments');
  }
  for (const field of ['feePerSide', 'halfSpread', 'slippagePerSide']) {
    if (!Number.isFinite(costs[field]) || costs[field] < 0) throw new Error('Invalid execution costs');
  }
  const reference = market[protocol.data.symbols[0]];
  const first = Date.parse(reference[0].time);
  const start = reference.findIndex((b) => Date.parse(b.time) >= from);
  const after = reference.findIndex((b) => Date.parse(b.time) >= to);
  const end = after === -1 ? reference.length : after;
  if (from < first || start < 0 || end <= start || to > Date.parse(reference.at(-1).time) + STEP) throw new Error('Simulation outside validated data');
  const state = {
    initial, balance: initial, position: null, peakClose: initial, peakBound: initial, maxCloseDd: 0, maxIntrabarDd: 0,
    status: 'running', reason: null, stoppedAt: null, day: null, baseline: initial, floor: initial * 0.95,
    dayBlocked: false, lastCompleted: from, tradeDays: new Set(), events: []
  };
  const trades = [], daily = [];
  let dayRecord, exposureBars = 0, bars = 0, peakExposure = 0, grossExposure = 0, lastTime = from;
  const quote = (mid) => {
    const p = state.position;
    if (!p) return { equity: state.balance, marked: state.balance };
    const price = fillPrice(mid, p.direction, false, costs);
    const marked = state.balance + p.quantity * p.direction * (price - p.entryPrice);
    return { marked, equity: marked - p.quantity * price * costs.feePerSide };
  };
  const recordMark = (equity, favorable = null) => {
    if (favorable !== null) state.peakBound = Math.max(state.peakBound, favorable);
    state.maxIntrabarDd = Math.max(state.maxIntrabarDd, (state.peakBound - equity) / state.peakBound * 100);
    dayRecord.minEquity = Math.min(dayRecord.minEquity, equity);
  };
  const close = (mid, time, reason) => {
    const p = state.position;
    if (!p) return;
    const exitPrice = fillPrice(mid, p.direction, false, costs), exitFee = p.quantity * exitPrice * costs.feePerSide;
    const netPnl = p.quantity * p.direction * (exitPrice - p.entryPrice) - p.entryFee - exitFee;
    state.balance += p.quantity * p.direction * (exitPrice - p.entryPrice) - exitFee;
    trades.push({
      id: `${candidate.id}:${iso(p.entered)}:${p.symbol}`, ...p,
      entryTime: iso(p.entered), exitTime: iso(time), exitMid: mid, exitPrice, exitFee, netPnl,
      grossMidPnl: p.quantity * p.direction * (mid - p.entryMid),
      spreadSlippage: p.quantity * (Math.abs(p.entryPrice - p.entryMid) + Math.abs(exitPrice - mid)),
      reason, balanceAfter: state.balance, durationHours: (time - p.entered) / 3600000
    });
    state.position = null;
    state.lastCompleted = time;
    dayRecord.trades++;
  };
  const halt = (status, reason, mid, time, certainty) => {
    state.status = status; state.reason = reason; state.stoppedAt = iso(time);
    state.events.push({ time: iso(time), reason, certainty });
    close(mid, time, reason);
  };
  const checkRisk = (mid, time, certainty = 'modeled-open-or-close') => {
    if (mode === 'economic' || state.status !== 'running') return;
    const { equity } = quote(mid);
    const breach = firmViolation(state.balance, equity, state.floor, initial);
    if (breach) halt('breach', breach, mid, time, certainty);
    else if (equity <= state.peakClose * (1 - protocol.execution.internalDrawdown)) {
      halt('internal-stop', 'internal-drawdown', mid, time, certainty);
    } else if (!state.dayBlocked && equity <= state.baseline * (1 - protocol.execution.internalDailyLoss)) {
      state.dayBlocked = true;
      state.events.push({ time: iso(time), reason: 'internal-daily-stop', certainty });
      close(mid, time, 'internal-daily-stop');
    }
    // A forced exit can itself cross a floor; no recovery or netting after that loss.
    if (!state.position && state.status === 'running') {
      const exitBreach = firmViolation(state.balance, state.balance, state.floor, initial);
      if (exitBreach) halt('breach', exitBreach, mid, time, certainty);
    }
  };
  const finishDay = (equity, time) => {
    dayRecord.endEquity = equity; dayRecord.netPnl = equity - dayRecord.startEquity;
    dayRecord.time = iso(time); dayRecord.closeDrawdownPct = (state.peakClose - equity) / state.peakClose * 100;
    dayRecord.maxIntrabarDrawdownPct = state.maxIntrabarDd;
  };
  const indeterminateGap = (knownTime, knownMid) => {
    state.finalEquity = quote(knownMid).equity;
    state.status = 'data-indeterminate'; state.reason = 'missing-bars-with-open-position';
    state.stoppedAt = iso(knownTime + STEP);
    state.unresolvedPosition = { ...state.position, lastKnownMid: knownMid, lastKnownTime: iso(knownTime), lastKnownEquity: state.finalEquity };
    state.events.push({ time: state.stoppedAt, reason: state.reason, certainty: 'unknown-execution-no-invented-exit' });
  };
  for (let i = start; i < end; i++) {
    const time = Date.parse(reference[i].time), closeTime = time + STEP;
    if (i > start && time !== Date.parse(reference[i - 1].time) + STEP && state.position) {
      const knownTime = Date.parse(reference[i - 1].time) + STEP;
      const knownMid = market[state.position.symbol][i - 1].close;
      indeterminateGap(knownTime, knownMid);
      break;
    }
    const symbol = state.position?.symbol ?? protocol.data.symbols[0];
    let bar = market[symbol][i];
    if (!bar || Date.parse(bar.time) !== time) throw new Error('Missing execution bar');
    const newDay = platformDay(time);
    if (state.day !== newDay) {
      const opening = quote(bar.open);
      state.day = newDay; state.baseline = Math.max(state.balance, opening.marked);
      state.floor = dailyFloor(state.balance, opening.marked); state.dayBlocked = false;
      dayRecord = {
        day: newDay, time: iso(time), startEquity: daily.at(-1)?.endEquity ?? initial,
        openingBalance: state.balance, openingEquity: opening.marked, baseline: state.baseline,
        floor: state.floor, minEquity: opening.equity, trades: 0, endEquity: opening.equity, netPnl: 0
      };
      daily.push(dayRecord);
    }
    bars++;
    recordMark(quote(bar.open).equity, quote(bar.open).equity);
    checkRisk(bar.open, time);
    if (state.status === 'running' && mode === 'challenge' && time - state.lastCompleted >= protocol.account.inactivityDays * DAY) {
      halt('inactivity', '30-calendar-days-no-completed-trade', bar.open, time, 'modeled-clock');
    }
    let usedBar = Boolean(state.position);
    if (state.status === 'running' && state.position) {
      const p = state.position;
      if (p.direction * (bar.open - p.stop) <= 0) close(bar.open, time, 'gap-stop');
      else if (p.direction * (bar.open - p.target) >= 0) close(p.target, time, 'gap-target');
      checkRisk(bar.open, time);
    }
    // At most one position during a bar, even when an opening exit releases margin.
    if (state.status === 'running' && !state.position && !usedBar && !state.dayBlocked && entryAllowed(time)) {
      for (const order of orders.get(time) ?? []) {
        if (order.signalTime !== iso(time)) throw new Error('Order is not from immediately preceding closed signal');
        bar = market[order.symbol][i];
        if (!bar || Date.parse(bar.time) !== time) throw new Error('Missing entry bar');
        if (Math.abs(bar.open - order.close) > order.atr) continue;
        const quantity = sizePosition(state.balance, order, bar.open, candidate.riskRate, costs, leverage, initial);
        if (quantity <= 0) continue;
        const entryPrice = fillPrice(bar.open, order.direction, true, costs);
        const entryFee = quantity * entryPrice * costs.feePerSide;
        state.position = {
          symbol: order.symbol, direction: order.direction, entered: time, entryMid: bar.open, entryPrice, entryFee,
          quantity, stop: order.stop, target: entryPrice + order.direction * order.rewardRisk * Math.abs(entryPrice - order.stop),
          deadline: Math.min(time + order.maxHoldHours * 3600000, cutoff(time)),
          riskBudget: candidate.riskRate * Math.min(initial, state.balance),
          margin: quantity * entryPrice / leverage
        };
        state.balance -= entryFee;
        state.position.freeMarginAtEntry = quote(bar.open).equity - state.position.margin;
        if (state.position.freeMarginAtEntry < -1e-8) throw new Error('Negative net free margin');
        state.tradeDays.add(platformDay(time));
        usedBar = true;
        checkRisk(bar.open, time);
        break;
      }
    }
    if (usedBar) exposureBars++;
    if (state.position && state.status === 'running') {
      const p = state.position;
      bar = market[p.symbol][i];
      const exposure = p.quantity * bar.open / Math.max(1, quote(bar.open).equity) * 100;
      peakExposure = Math.max(peakExposure, exposure); grossExposure += exposure;
      const adverse = p.direction === 1 ? Math.max(bar.low, p.stop) : Math.min(bar.high, p.stop);
      const favorable = p.direction === 1 ? Math.min(bar.high, p.target) : Math.max(bar.low, p.target);
      recordMark(quote(adverse).equity, quote(favorable).equity);
      checkRisk(adverse, closeTime, 'possible-intrabar-bound-not-tick-proof');
      if (state.position && state.status === 'running') {
        if (p.direction === 1 ? bar.low <= p.stop : bar.high >= p.stop) close(p.stop, closeTime, 'stop-first');
        else if (p.direction === 1 ? bar.high >= p.target : bar.low <= p.target) close(p.target, closeTime, 'target');
        else if (closeTime >= p.deadline) close(bar.close, closeTime, 'time-or-session');
      }
    }
    if (closeTime === to && state.position) close(bar.close, closeTime, 'window-end');
    checkRisk(bar.close, closeTime);
    const equity = quote(bar.close).equity;
    recordMark(equity, equity);
    state.peakClose = Math.max(state.peakClose, equity);
    state.maxCloseDd = Math.max(state.maxCloseDd, (state.peakClose - equity) / state.peakClose * 100);
    finishDay(equity, closeTime);
    lastTime = closeTime;
    if (state.status === 'running' && target !== null && !state.position &&
      state.balance >= initial * (1 + target) && state.tradeDays.size >= protocol.account.minimumTradingDays) {
      state.status = 'target'; state.stoppedAt = iso(closeTime);
    }
    if (state.status !== 'running') break;
  }
  if (state.status === 'running' && lastTime < to) {
    if (state.position) indeterminateGap(lastTime, market[state.position.symbol][end - 1].close);
    else {
      if (mode === 'challenge' && to - state.lastCompleted >= protocol.account.inactivityDays * DAY) {
        halt('inactivity', '30-calendar-days-no-completed-trade', 0,
          state.lastCompleted + protocol.account.inactivityDays * DAY, 'modeled-clock-flat-during-data-gap');
      }
      lastTime = to;
      finishDay(state.balance, to);
    }
  }
  if (state.position && state.status !== 'data-indeterminate') throw new Error('Unliquidated terminal research position');
  if (!state.position) state.finalEquity = state.balance;
  const net = trades.reduce((sum, t) => sum + t.netPnl, 0);
  if (Math.abs(state.balance - initial - net + (state.position?.entryFee ?? 0)) > 1e-7) throw new Error('Research ledger fails reconciliation');
  return {
    candidate: candidate.id, mode, leverage, costs: costs.id, target,
    metrics: stats(trades, daily, state, from, lastTime, exposureBars, bars, peakExposure, grossExposure),
    trades, daily
  };
}

export function buyHold(market, from, to, costs = protocol.costs[0]) {
  let endBalance = 0, fees = 0;
  const initial = protocol.account.initial;
  for (const symbol of protocol.data.symbols) {
    const first = market[symbol].find((b) => Date.parse(b.time) === from);
    const last = market[symbol].find((b) => Date.parse(b.time) === to - STEP);
    if (!first || !last) throw new Error('Missing benchmark endpoints');
    const entry = fillPrice(first.open, 1, true, costs), exit = fillPrice(last.close, 1, false, costs);
    const quantity = initial / 2 / (entry * (1 + costs.feePerSide));
    fees += quantity * (entry + exit) * costs.feePerSide;
    endBalance += quantity * exit * (1 - costs.feePerSide);
  }
  return { initial, endingBalance: endBalance, netReturnPct: (endBalance / initial - 1) * 100, totalFees: fees,
    description: 'Equal-dollar BTC/ETH spot buy-and-hold, fully invested, costs both ends. Not day trading, not risk/leverage matched, not a challenge strategy.', cashReturnPct: 0 };
}

export function challenge({ market, orders, candidate, from, dataEnd, horizonDays, costs }) {
  const horizonEnd = from + horizonDays * DAY, to = Math.min(dataEnd, horizonEnd);
  const phase1 = simulate({ market, orders, candidate, from, to, costs, mode: 'challenge', target: protocol.account.phaseTargets[0] });
  let phase2 = null, outcome = phase1.metrics.status;
  if (outcome === 'target') {
    const nextDay = (Math.floor(Date.parse(phase1.metrics.stoppedAt) / DAY) + 1) * DAY;
    if (nextDay < to) {
      phase2 = simulate({ market, orders, candidate, from: nextDay, to, costs, mode: 'challenge', target: protocol.account.phaseTargets[1] });
      outcome = phase2.metrics.status === 'target' ? 'pass' : phase2.metrics.status;
    } else outcome = 'running';
  }
  if (outcome === 'running') outcome = horizonEnd <= dataEnd ? 'pending' : 'censored';
  const last = phase2 ?? phase1;
  return {
    start: iso(from), horizonDays, horizonEnd: iso(horizonEnd), observedEnd: iso(to),
    fullHorizonObserved: horizonEnd <= dataEnd, outcome,
    reason: last.metrics.reason, compliance: 'Conditional OHLC proxy; actual broker/news compliance indeterminate',
    phase1: phase1.metrics, phase2: phase2?.metrics ?? null,
    phase1Days: phase1.metrics.status === 'target' ? (Date.parse(phase1.metrics.stoppedAt) - from) / DAY : null,
    phase2Days: phase2?.metrics.status === 'target' ? (Date.parse(phase2.metrics.stoppedAt) - Date.parse(phase2.metrics.from)) / DAY : null,
    totalDays: outcome === 'pass' ? (Date.parse(last.metrics.stoppedAt) - from) / DAY : null,
    ledgers: { phase1: phase1.trades, phase2: phase2?.trades ?? [] },
    daily: { phase1: phase1.daily, phase2: phase2?.daily ?? [] }
  };
}
