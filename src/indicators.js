export function ema(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new Error('Invalid EMA period');
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value += alpha * (values[i] - value);
    result[i] = value;
  }
  return result;
}

export function atr(candles, period) {
  if (!Number.isInteger(period) || period < 1) throw new Error('Invalid ATR period');
  const ranges = candles.map((bar, i) => i === 0 ? bar.high - bar.low : Math.max(
    bar.high - bar.low, Math.abs(bar.high - candles[i - 1].close), Math.abs(bar.low - candles[i - 1].close)
  ));
  const result = Array(candles.length).fill(null);
  if (candles.length < period) return result;
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = value;
  for (let i = period; i < ranges.length; i++) {
    value = (value * (period - 1) + ranges[i]) / period;
    result[i] = value;
  }
  return result;
}

export function signals(candles, config) {
  return candles.map((bar, i) => {
    // A fixed trailing seed window makes one-bar runs and batched catch-up identical.
    const window = candles.slice(Math.max(0, i - WARMUP), i + 1);
    const closes = window.map((item) => item.close);
    const fast = ema(closes, config.emaFast).at(-1);
    const slow = ema(closes, config.emaSlow).at(-1);
    const volatility = atr(window, config.atrPeriod).at(-1);
    const ready = i >= config.breakoutBars && fast !== null && slow !== null && volatility > 0;
    const breakout = ready ? Math.max(...candles.slice(i - config.breakoutBars, i).map((b) => b.high)) : null;
    const enter = ready && fast > slow && bar.close > fast && bar.close > breakout;
    return {
      time: bar.time,
      signal: enter ? 'BUY SETUP' : 'WAIT',
      reason: !ready ? 'Indicator warmup' : enter ? 'EMA trend and 20-bar closing breakout' : 'No qualifying breakout',
      close: bar.close,
      emaFast: fast,
      emaSlow: slow,
      atr: volatility,
      stop: enter ? bar.close - config.stopAtr * volatility : null
    };
  });
}
import { WARMUP } from './config.js';
