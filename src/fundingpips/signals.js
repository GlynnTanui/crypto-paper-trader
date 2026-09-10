import { ema, atr } from '../indicators.js';
import { validateMarket } from '../market.js';
import { STEP, iso } from '../config.js';
import { protocol, validateResearchMarket, excludedDates } from './data.js';

const HOUR = 4 * STEP;
export function aggregateHours(candles) {
  const hours = [];
  for (let i = 0; i < candles.length; i += 4) {
    const group = candles.slice(i, i + 4);
    if (group.length < 4) break;
    if (Date.parse(group[0].time) % HOUR || group.some((bar, j) => Date.parse(bar.time) !== Date.parse(group[0].time) + j * STEP)) {
      throw new Error('Incomplete/misaligned hourly signal input');
    }
    hours.push({
      time: group[0].time, open: group[0].open, close: group[3].close,
      high: Math.max(...group.map((b) => b.high)), low: Math.min(...group.map((b) => b.low)),
      volume: group.reduce((sum, b) => sum + b.volume, 0)
    });
  }
  return hours;
}

export function entryAllowed(time) {
  const date = new Date(time), day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 6 && hour < (day === 5 ? 14 : 16);
}

export function cutoff(time) {
  const date = new Date(time);
  date.setUTCHours(date.getUTCDay() === 5 ? 16 : 20, 0, 0, 0);
  return date.getTime();
}

export function prepare(market, { allowGaps = false } = {}) {
  if (allowGaps) validateResearchMarket(market);
  else validateMarket(market);
  const reference = market[protocol.data.symbols[0]];
  const excludedDays = excludedDates(market, Date.parse(reference[0].time), Date.parse(reference.at(-1).time) + STEP);
  const features = Object.fromEntries(protocol.data.symbols.map((symbol) => {
    const bars = market[symbol], segments = [];
    let start = 0;
    for (let i = 1; i <= bars.length; i++) {
      if (i === bars.length || Date.parse(bars[i].time) !== Date.parse(bars[i - 1].time) + STEP) {
        while (start < i && Date.parse(bars[start].time) % HOUR) start++;
        const completeEnd = i - (i - start) % 4;
        if (completeEnd > start) segments.push(bars.slice(start, completeEnd));
        start = i;
      }
    }
    return [symbol, segments.map((segment) => {
      const hours = aggregateHours(segment);
      const closes = hours.map((bar) => bar.close);
      const fast = ema(closes, 20), slow = ema(closes, 80), volatility = atr(hours, 14);
      const bands = closes.map((_, i) => {
        if (i < 19) return null;
        const sample = closes.slice(i - 19, i + 1);
        const mean = sample.reduce((a, b) => a + b, 0) / 20;
        return { mean, sigma: Math.sqrt(sample.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 20) };
      });
      return { hours, fast, slow, volatility, bands };
    })];
  }));
  return { ...features, excludedDays };
}

export function makeOrders(features, candidate) {
  const family = protocol.families.find((f) => f.id === candidate.family);
  if (!family || !family.parameters.includes(candidate.parameter)) throw new Error('Unregistered family/parameter');
  const orders = new Map();
  for (const symbol of protocol.data.symbols) {
    for (const { hours, fast, slow, volatility, bands } of features[symbol]) {
    for (let i = protocol.data.warmupHours; i < hours.length; i++) {
      const bar = hours[i], prev = hours[i - 1], time = Date.parse(bar.time) + HOUR, a = volatility[i];
      if (!entryAllowed(time) || !(a > 0)) continue;
      let direction = 0, stopAtr;
      if (candidate.family === 'breakout') {
        const range = hours.slice(i - candidate.parameter, i);
        if (fast[i] > slow[i] && bar.close > Math.max(...range.map((b) => b.high))) direction = 1;
        if (fast[i] < slow[i] && bar.close < Math.min(...range.map((b) => b.low))) direction = -1;
        stopAtr = 2;
      } else if (candidate.family === 'pullback') {
        if (fast[i] > slow[i] && prev.close <= fast[i - 1] && bar.close > fast[i]) direction = 1;
        if (fast[i] < slow[i] && prev.close >= fast[i - 1] && bar.close < fast[i]) direction = -1;
        stopAtr = candidate.parameter;
      } else if (candidate.family === 'reversion') {
        const before = bands[i - 1], current = bands[i], n = candidate.parameter;
        if (Math.abs(fast[i] - slow[i]) <= a &&
          bar.close >= current.mean - n * current.sigma && bar.close <= current.mean + n * current.sigma) {
          if (prev.close < before.mean - n * before.sigma && bar.close >= current.mean - n * current.sigma) direction = 1;
          if (prev.close > before.mean + n * before.sigma && bar.close <= current.mean + n * current.sigma) direction = -1;
        }
        stopAtr = 1.5;
      } else if (candidate.family === 'session') {
        const closeHour = new Date(time).getUTCHours();
        if (closeHour < 7 || closeHour > 12) continue;
        const dayStart = Math.floor(time / 86400000) * 86400000;
        const firstIndex = i - new Date(bar.time).getUTCHours();
        const range = hours.slice(firstIndex, firstIndex + 6);
        if (range.length !== 6 || Date.parse(range[0].time) !== dayStart) throw new Error('Incomplete session range');
        const high = Math.max(...range.map((b) => b.high)), low = Math.min(...range.map((b) => b.low));
        if (high - low >= a && high - low <= 4 * a && prev.close >= low && prev.close <= high) {
          if (prev.close <= high && bar.close > high) direction = 1;
          if (prev.close >= low && bar.close < low) direction = -1;
        }
        stopAtr = candidate.parameter;
      }
      if (direction) {
        const order = {
          symbol, direction, signalTime: iso(time), close: bar.close, atr: a,
          stop: bar.close - direction * stopAtr * a, rewardRisk: family.rewardRisk,
          maxHoldHours: family.maxHoldHours
        };
        orders.set(time, [...(orders.get(time) ?? []), order]);
      }
    }
    }
  }
  return orders;
}
