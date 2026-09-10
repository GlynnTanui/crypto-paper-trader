import { createHash } from 'node:crypto';

export const CONFIG = Object.freeze({
  symbols: Object.freeze(['BTC-USD', 'ETH-USD']),
  intervalMinutes: 15,
  riskPerTrade: 0.0025,
  maxExposure: 0.5,
  maxPositionExposure: 0.25,
  maxPositions: 2,
  dailyLossLimit: 0.015,
  maxDrawdown: 0.08,
  feeRate: 0.001,
  slippageRate: 0.0005,
  emaFast: 20,
  emaSlow: 50,
  breakoutBars: 20,
  atrPeriod: 14,
  stopAtr: 2,
  targetR: 2,
  maxHoldBars: 16
});

export const STEP = CONFIG.intervalMinutes * 60_000;
export const WARMUP = 150;
export const STARTING_BALANCE = 10_000;
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const configHash = (config = CONFIG) => hash(config);
export const iso = (time) => new Date(time).toISOString();
export const round = (value) => Math.round(value * 1e8) / 1e8;
