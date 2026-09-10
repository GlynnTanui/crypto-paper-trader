import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIG, STEP, iso } from './config.js';

const ENDPOINT = 'https://api.exchange.coinbase.com';

export function validateCandles(candles, { from, to, now = Date.now() } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error('No market candles received');
  let previous;
  for (const bar of candles) {
    const time = Date.parse(bar.time);
    if (!Number.isFinite(time) || time % STEP !== 0 || iso(time) !== bar.time) throw new Error('Invalid candle timestamp');
    if (time + STEP > now) throw new Error('Unclosed future candle rejected');
    if (previous !== undefined && time !== previous + STEP) throw new Error(`Missing/duplicate candle at ${bar.time}`);
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[field]) || bar[field] < 0 || (field !== 'volume' && bar[field] === 0)) {
        throw new Error(`Invalid candle ${field} at ${bar.time}`);
      }
    }
    if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
      throw new Error(`Inconsistent OHLC at ${bar.time}`);
    }
    previous = time;
  }
  if (from !== undefined && Date.parse(candles[0].time) !== from) throw new Error(`Market data does not start at ${iso(from)}`);
  if (to !== undefined && previous !== to - STEP) throw new Error(`Market data incomplete through ${iso(to)}`);
  return candles;
}

export function validateMarket(market, { config = CONFIG, from, to, now = Date.now(), fresh = false } = {}) {
  for (const symbol of config.symbols) validateCandles(market[symbol], { from, to, now });
  const reference = market[config.symbols[0]];
  for (const symbol of config.symbols.slice(1)) {
    const series = market[symbol];
    if (series.length !== reference.length || series.some((bar, i) => bar.time !== reference[i].time)) {
      throw new Error('Markets do not have identical USD candle coverage');
    }
  }
  if (fresh && now - (Date.parse(reference.at(-1).time) + STEP) > 30 * 60_000) {
    throw new Error('Stale market data: latest closed candle is over 30 minutes old');
  }
  return market;
}

export async function fetchJson(url, { fetcher = fetch, wait = sleep } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        headers: { 'User-Agent': 'crypto-paper-trader/1.0 (public paper research)', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error;
      if (attempt === 3) throw new Error(`Public candle network failure: ${error.message}`, { cause: error });
      await wait(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response.json();
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`Public candle provider HTTP ${response.status}; no fallback provider or synthetic data`);
    }
    await wait(1000 * 2 ** attempt);
  }
  throw new Error('Public candle request exhausted');
}

export async function fetchCandles(symbol, from, to, options = {}) {
  if (!CONFIG.symbols.includes(symbol) || from % STEP || to % STEP || from >= to) throw new Error('Invalid candle request');
  const byTime = new Map();
  for (let start = from; start < to; start += 250 * STEP) {
    const end = Math.min(to, start + 250 * STEP);
    const url = new URL(`/products/${symbol}/candles`, ENDPOINT);
    url.search = new URLSearchParams({ granularity: '900', start: iso(start), end: iso(end) }).toString();
    const rows = await fetchJson(url, options);
    if (!Array.isArray(rows)) throw new Error('Malformed Coinbase response');
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6 || row.some((v) => !Number.isFinite(v))) {
        throw new Error('Malformed Coinbase candle');
      }
      const [seconds, low, high, open, close, volume] = row;
      const time = seconds * 1000;
      if (time < from || time >= to) continue;
      const bar = { time: iso(time), open, high, low, close, volume };
      const previous = byTime.get(time);
      if (previous && JSON.stringify(previous) !== JSON.stringify(bar)) throw new Error('Conflicting duplicate provider candle');
      byTime.set(time, bar);
    }
    await (options.wait ?? sleep)(150);
  }
  return validateCandles([...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)), { from, to, now: options.now });
}

export async function fetchMarket(from, to, options = {}) {
  const market = {};
  for (const symbol of CONFIG.symbols) market[symbol] = await fetchCandles(symbol, from, to, options);
  return validateMarket(market, { from, to, now: options.now, fresh: options.fresh });
}
