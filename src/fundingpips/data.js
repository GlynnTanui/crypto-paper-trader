import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fetchJson, validateCandles, validateMarket } from '../market.js';
import { readJson, writeJson } from '../storage.js';
import { STEP, hash, iso } from '../config.js';

export const ROOT = 'research/fundingpips';
export const protocol = JSON.parse(await readFile(new URL('../../research/fundingpips/protocol.json', import.meta.url), 'utf8'));

function parseRows(rows, step) {
  if (!Array.isArray(rows)) throw new Error('Malformed historical response');
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 6 || row.some((v) => !Number.isFinite(v))) throw new Error('Malformed historical candle');
    const [seconds, low, high, open, close, volume] = row;
    if (seconds * 1000 % step || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) {
      throw new Error('Invalid historical source OHLCV');
    }
    return { time: iso(seconds * 1000), open, high, low, close, volume };
  });
}

async function pageFromSource(symbol, from, to) {
  const request = async (start, end, seconds) => {
    const url = new URL(`https://api.exchange.coinbase.com/products/${symbol}/candles`);
    url.search = new URLSearchParams({ granularity: `${seconds}`, start: iso(start), end: iso(end) }).toString();
    const rows = await fetchJson(url);
    await sleep(150);
    return parseRows(rows, seconds * 1000).filter((b) => Date.parse(b.time) >= start && Date.parse(b.time) < end);
  };
  const candles = await request(from, to, 900);
  const byTime = new Map();
  for (const bar of candles) {
    if (byTime.has(bar.time)) throw new Error('Duplicate historical source candle');
    byTime.set(bar.time, bar);
  }
  const repairs = [], gaps = [];
  for (let time = from; time < to; time += STEP) {
    if (byTime.has(iso(time))) continue;
    const source = (await request(time, time + STEP, 300)).sort((a, b) => a.time.localeCompare(b.time));
    if (source.length !== 3 || source.some((b, i) => Date.parse(b.time) !== time + i * 300000)) {
      gaps.push({ time: iso(time), reason: 'Incomplete Coinbase 900s and 300s history; excluded under A2', available300s: source });
      console.log(`Excluded real-data gap: ${symbol} ${iso(time)}`);
      continue;
    }
    const reconstructed = {
      time: iso(time), open: source[0].open, high: Math.max(...source.map((b) => b.high)),
      low: Math.min(...source.map((b) => b.low)), close: source[2].close, volume: source.reduce((sum, b) => sum + b.volume, 0)
    };
    byTime.set(iso(time), reconstructed);
    repairs.push({ time: iso(time), method: 'Three complete real Coinbase 300s candles', source });
    console.log(`Real 5m aggregation: ${symbol} ${iso(time)}`);
  }
  return { candles: [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)), repairs, gaps };
}

export function validateResearchMarket(market) {
  const symbols = protocol.data.symbols, reference = market[symbols[0]];
  if (!reference?.length) throw new Error('Empty historical research data');
  for (const symbol of symbols) {
    const bars = market[symbol];
    if (!bars?.length) throw new Error('Empty research series');
    let start = 0;
    for (let i = 1; i <= bars.length; i++) {
      if (i === bars.length || Date.parse(bars[i].time) !== Date.parse(bars[i - 1].time) + STEP) {
        validateCandles(bars.slice(start, i));
        if (i < bars.length && Date.parse(bars[i].time) <= Date.parse(bars[i - 1].time)) throw new Error('Duplicate or unordered research candle');
        start = i;
      }
    }
    if (bars.length !== reference.length || bars.some((b, i) => b.time !== reference[i].time)) throw new Error('Research alignment mismatch');
  }
  return market;
}

export function excludedDates(market, from = Date.parse(protocol.data.from), to = Date.parse(protocol.data.to)) {
  const dates = new Set();
  let expected = from;
  for (const bar of market[protocol.data.symbols[0]]) {
    const time = Date.parse(bar.time);
    for (; expected < time; expected += STEP) dates.add(iso(expected).slice(0, 10));
    expected = time + STEP;
  }
  for (; expected < to; expected += STEP) dates.add(iso(expected).slice(0, 10));
  return dates;
}

export async function loadData(directory = ROOT) {
  const data = JSON.parse(gunzipSync(await readFile(join(directory, 'market.json.gz'))));
  const manifest = await readJson(join(directory, 'provenance.json'));
  validateResearchMarket(data);
  if (hash(data) !== manifest.marketSha256 || hash(protocol) !== manifest.protocolSha256) throw new Error('Research data/protocol hash mismatch');
  return { market: data, provenance: manifest };
}

export async function acquire({ directory = ROOT, cache = 'runtime/fundingpips-cache' } = {}) {
  const from = Date.parse(protocol.data.from), to = Date.parse(protocol.data.to);
  if (to > Date.now()) throw new Error('Research end has not closed');
  const market = {};
  const pages = [];
  for (const symbol of protocol.data.symbols) {
    market[symbol] = [];
    let completed = 0;
    for (let start = from; start < to; start += 250 * STEP) {
      const end = Math.min(to, start + 250 * STEP);
      const path = join(cache, symbol, `${start}.json`);
      let page = await readJson(path, { optional: true });
      if (!page) {
        const { candles, repairs, gaps } = await pageFromSource(symbol, start, end);
        page = { symbol, from: iso(start), to: iso(end), retrievedAt: iso(Date.now()), candles, repairs, gaps };
        await writeJson(path, page);
      }
      const expectedTimes = new Set(Array.from({ length: (end - start) / STEP }, (_, i) => iso(start + i * STEP)));
      for (const item of [...page.candles, ...(page.gaps ?? [])]) {
        if (!expectedTimes.delete(item.time)) throw new Error('Duplicate/out-of-range cached observation or gap');
      }
      if (expectedTimes.size) throw new Error('Undeclared missing cached candles');
      if (page.symbol !== symbol || page.from !== iso(start) || page.to !== iso(end)) throw new Error('Cached page scope mismatch');
      market[symbol].push(...page.candles);
      pages.push({ symbol, from: page.from, to: page.to, retrievedAt: page.retrievedAt, sha256: hash(page.candles), repairs: page.repairs ?? [], gaps: page.gaps ?? [] });
      if (++completed % 40 === 0) console.log(`${symbol}: ${market[symbol].length} validated real candles`);
    }
  }
  const sets = protocol.data.symbols.map((s) => new Set(market[s].map((b) => b.time)));
  for (const symbol of protocol.data.symbols) market[symbol] = market[symbol].filter((b) => sets.every((set) => set.has(b.time)));
  validateResearchMarket(market);
  await mkdir(directory, { recursive: true });
  const archive = gzipSync(JSON.stringify(market), { level: 9 });
  await writeFile(join(directory, 'market.json.gz'), archive);
  const provenance = {
    schemaVersion: 1, provider: protocol.data.provider, endpoint: 'https://api.exchange.coinbase.com/products/{symbol}/candles',
    granularitySeconds: 900, from: iso(from), to: iso(to), retrievedAt: iso(Date.now()),
    protocolSha256: hash(protocol), marketSha256: hash(market),
    archiveSha256: hash(archive.toString('base64')),
    archiveHashEncoding: 'SHA256 of base64 archive string using shared hash(JSON.stringify(value)); market hash uses shared hash(market).',
    barsPerSymbol: Object.fromEntries(protocol.data.symbols.map((symbol) => [symbol, market[symbol].length])),
    expectedBarsPerSymbol: (to - from) / STEP,
    gapUtcDates: [...excludedDates(market)].sort(),
    coveragePolicy: 'A3 causal primary: retain pre-gap entries; reset warmup after gaps; open-gap paths data-indeterminate, not erased or filled. A2 whole-day exclusions superseded.',
    recovered15mBars: pages.reduce((sum, p) => sum + p.repairs.length, 0),
    missing15mSourceBars: pages.reduce((sum, p) => sum + p.gaps.length, 0),
    amendments: await readJson(join(ROOT, 'amendments.json')),
    pages, revisions: 'Cached validated pages reused. A1 real 5m reconstruction; A3 causal gap handling supersedes A2 whole-day exclusions. No interpolation. Open-gap paths indeterminate.'
  };
  await writeJson(join(directory, 'provenance.json'), provenance);
  console.log(`Complete: ${provenance.marketSha256}; archive ${archive.length} bytes`);
  return provenance;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  acquire().catch((error) => { console.error(error); process.exitCode = 1; });
}
