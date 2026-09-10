import { CONFIG, STEP, iso } from './config.js';
import { validateState } from './engine.js';

export function snapshot(state, health) {
  if (!health || !['healthy', 'error', 'initializing'].includes(health.status) ||
      !Number.isFinite(Date.parse(health.generatedAt))) throw new Error('Invalid automation health');
  if (state) validateState(state);
  const marketAsOf = state?.lastProcessed ? iso(Date.parse(state.lastProcessed) + STEP) : null;
  const scheduleOffset = 7 * 60_000;
  const nextScheduled = (Math.floor((Date.parse(health.generatedAt) - scheduleOffset) / STEP) + 1) * STEP + scheduleOffset;
  return {
    meta: {
      schemaVersion: 1, generatedAt: health.generatedAt, lastSuccessAt: health.lastSuccessAt ?? null,
      marketAsOf, nextExpectedUpdate: iso(nextScheduled),
      status: health.status, message: health.message,
      catchUp: 'Hypothetical closed-bar replay. Delayed jobs replay historical bars; these are not contemporaneous executable fills.'
    },
    account: state ? {
      id: state.id, startingBalance: state.startingBalance, createdAt: state.createdAt,
      cash: state.cash, equity: state.equity, realizedPnl: state.realizedPnl,
      unrealizedPnl: state.unrealizedPnl, totalFees: state.totalFees,
      netReturnPct: (state.equity / state.startingBalance - 1) * 100,
      exposure: state.exposure, drawdownPct: state.drawdownPct, maxDrawdownPct: state.maxDrawdownPct,
      paused: state.paused, riskHalt: state.riskHalt, dayPnl: state.dayPnl, lastProcessed: state.lastProcessed
    } : null,
    config: CONFIG,
    market: state?.market ?? [],
    positions: state?.positions ?? [],
    fills: state?.fills ?? [],
    equityHistory: state?.equityHistory ?? [],
    decisions: state?.decisions ?? [],
    activity: state?.activity ?? []
  };
}
