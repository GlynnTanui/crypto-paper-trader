import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readJson, writeJson } from '../storage.js';
import { hash } from '../config.js';
import { ROOT, protocol, loadData } from './data.js';
import { prepare, makeOrders } from './signals.js';
import { DAY, simulate, buyHold, challenge } from './engine.js';

const period = (name) => protocol.splits[name].map(Date.parse);
const compact = ({ trades, daily, ...run }) => run;
const engineFiles = ['data.js', 'signals.js', 'engine.js', 'study.js'];
const median = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function rankCandidate(candidate, runs) {
  const t = runs.training.metrics, v = runs.validation.metrics, s = runs.validationDouble.metrics;
  const quarters = ['2025-07', '2025-10'].map((q, i) => {
    const end = i === 0 ? '2025-10' : '2026-01';
    return { from: q, to: end, netPnl: runs.validation.daily.filter((d) => d.day >= q && d.day < end).reduce((sum, d) => sum + d.netPnl, 0) };
  });
  const reasons = [];
  if ([t, v, s].some((m) => m.complete === false)) reasons.push('Data-indeterminate primary development path; prefix is not full-period evidence');
  if (t.netReturnPct <= 0 || v.netReturnPct <= 0) reasons.push('Nonpositive training or validation return');
  if (t.profitFactor === null || v.profitFactor === null || t.profitFactor < 1.1 || v.profitFactor < 1.1) reasons.push('Training or validation PF below 1.10/undefined');
  if (t.tradeCount < 100 || v.tradeCount < 40) reasons.push('Fewer than 100 training / 40 validation trades');
  if (quarters.some((q) => q.netPnl <= 0)) reasons.push('Not both validation quarters profitable');
  if (s.netReturnPct <= 0) reasons.push('Double-cost validation not profitable');
  if (t.maxIntrabarDrawdownPct >= 5 || v.maxIntrabarDrawdownPct >= 5) reasons.push('Training/validation intrabar drawdown at least 5%');
  const annualized = (m) => m.netReturnPct * 365 / ((Date.parse(m.to) - Date.parse(m.from)) / DAY);
  const score = Math.min(annualized(t), annualized(v), annualized(s)) /
    Math.max(1, t.maxIntrabarDrawdownPct, v.maxIntrabarDrawdownPct, s.maxIntrabarDrawdownPct);
  return {
    candidate, eligible: reasons.length === 0, rejectionReasons: reasons, score, validationQuarters: quarters,
    ...Object.fromEntries(Object.entries(runs).map(([key, value]) => [key, value.metrics]))
  };
}

export function chooseFinalists(development) {
  const sorted = [...development].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const families = new Set(), selected = [];
  for (const row of sorted) {
    if (families.has(row.candidate.family)) continue;
    families.add(row.candidate.family);
    selected.push({
      candidate: row.candidate, eligible: row.eligible, score: row.score,
      role: row.eligible ? 'Development-qualified finalist' : 'Ineligible diagnostic control - NOT a validated strategy'
    });
    if (selected.length === 2) break;
  }
  return selected;
}

export function finalAssessment(finalist, metrics) {
  if (!metrics.complete) return 'Final path data-indeterminate. Last-known marked prefix is not full-period profitability evidence.';
  if (!finalist.eligible) return 'Failed preregistered development gates; final is diagnostic, not a tradable recommendation.';
  if (metrics.netReturnPct <= 0 || (metrics.profitFactor ?? 0) < 1.1) return 'Failed final profitability threshold; not a credible usable strategy.';
  return 'Positive conditional proxy, still no verified firm compliance or future edge.';
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(engineFiles.map(async (file) => [
    file, createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex')
  ])));
}

async function archive(path, data) {
  const compressed = gzipSync(JSON.stringify(data), { level: 9 });
  await writeFile(path, compressed);
  return { bytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') };
}

export async function developmentStudy({ directory = ROOT, dataDirectory = ROOT } = {}) {
  const { market, provenance } = await loadData(dataDirectory);
  const features = prepare(market, { allowGaps: true }), development = [], ledgers = {};
  for (const candidate of protocol.candidates) {
    const orders = makeOrders(features, candidate);
    const run = (split, costs, mode = 'economic') => {
      const [from, to] = period(split);
      return simulate({ market, orders, candidate, from, to, costs, mode });
    };
    const runs = {
      training: run('training', protocol.costs[0]),
      validation: run('validation', protocol.costs[0]),
      validationDouble: run('validation', protocol.costs[1]),
      managedTraining: run('training', protocol.costs[0], 'managed'),
      managedValidation: run('validation', protocol.costs[0], 'managed')
    };
    development.push(rankCandidate(candidate, runs));
    ledgers[candidate.id] = runs;
    console.log(`Development ${candidate.id}: train ${runs.training.metrics.netReturnPct.toFixed(2)}%, validation ${runs.validation.metrics.netReturnPct.toFixed(2)}%, double ${runs.validationDouble.metrics.netReturnPct.toFixed(2)}%`);
  }
  const selection = {
    schemaVersion: 1, protocolId: protocol.id, protocolSha256: hash(protocol), marketSha256: provenance.marketSha256,
    amendmentsSha256: hash(provenance.amendments), developmentSha256: hash(development),
    sourceSha256: await sourceHashes(), finalists: chooseFinalists(development),
    eligibleCount: development.filter((r) => r.eligible).length,
    statement: 'Locked using development only before final execution; repeat execution reproduces this fixed decision, not a new selection.'
  };
  await mkdir(directory, { recursive: true });
  const existing = await readJson(join(directory, 'selection.json'), { optional: true });
  if (existing && hash(existing) !== hash(selection)) throw new Error('Selection lock changed: refuse overwrite. Document a correction; never silently reselect on final data.');
  await writeJson(join(directory, 'development.json'), development);
  await archive(join(directory, 'development-ledgers.json.gz'), ledgers);
  await writeJson(join(directory, 'selection.json'), selection);
  console.log(`Development lock: ${selection.eligibleCount}/16 eligible; ${selection.finalists.map((f) => f.candidate.id).join(', ')}`);
  return { development, selection };
}

function cohortSummary(cohorts, horizonDays, costs) {
  const counts = (rows) => Object.fromEntries(['pass', 'breach', 'inactivity', 'internal-stop', 'pending', 'censored', 'data-indeterminate'].map((outcome) => [
    outcome, rows.filter((c) => c.outcome === outcome).length
  ]));
  const full = cohorts.filter((c) => c.fullHorizonObserved);
  const passes = cohorts.filter((c) => c.outcome === 'pass').length, fullPasses = full.filter((c) => c.outcome === 'pass').length;
  return {
    horizonDays, costs: costs.id, starts: cohorts.length, fullyObservedOpportunities: full.length,
    outcomes: counts(cohorts), fullyObservedOutcomes: counts(full),
    passFractionAllStarts: cohorts.length ? passes / cohorts.length : null,
    passFractionFullyObserved: full.length ? fullPasses / full.length : null,
    medianPhase1Days: median(cohorts.map((c) => c.phase1Days)), medianPhase2Days: median(cohorts.map((c) => c.phase2Days)),
    medianTotalPassDays: median(cohorts.map((c) => c.totalDays)),
    note: 'Overlapping, dependent historical scenarios with causal gap handling. Data-indeterminate paths stay in the denominator. Not independent trials or future pass probability. 60/120 days are analytical horizons, not firm deadlines.',
    cohorts: cohorts.map(({ ledgers, daily, ...c }) => c)
  };
}

export async function finalStudy({ directory = ROOT, dataDirectory = ROOT } = {}) {
  const { market, provenance } = await loadData(dataDirectory);
  const development = await readJson(join(directory, 'development.json'));
  const selection = await readJson(join(directory, 'selection.json'));
  if (selection.marketSha256 !== provenance.marketSha256 || selection.protocolSha256 !== hash(protocol) ||
    selection.developmentSha256 !== hash(development) || selection.amendmentsSha256 !== hash(provenance.amendments) ||
    hash(selection.finalists) !== hash(chooseFinalists(development)) || hash(selection.sourceSha256) !== hash(await sourceHashes())) {
    throw new Error('Selection/data/source lock mismatch. Final cannot run with changed rules or selection.');
  }
  const features = prepare(market, { allowGaps: true }), results = [], ledgers = {}, cohortLedgers = {};
  const [from, to] = period('final'), [recentFrom, recentTo] = period('exposed');
  const csv = [['candidate', 'symbol', 'direction', 'entryTime', 'exitTime', 'quantity', 'entryMid', 'exitMid', 'entryPrice', 'exitPrice', 'entryFee', 'exitFee', 'netPnl', 'reason', 'balanceAfter']];
  const dailyCsv = [['candidate', 'day', 'startEquity', 'endEquity', 'netPnl', 'minEquity', 'baseline', 'floor', 'closeDrawdownPct']];
  for (const finalist of selection.finalists) {
    const { candidate } = finalist, orders = makeOrders(features, candidate);
    const neighbor = protocol.candidates.find((c) => c.family === candidate.family && c.riskRate === candidate.riskRate && c.parameter !== candidate.parameter);
    const cases = {
      base: simulate({ market, orders, candidate, from, to, costs: protocol.costs[0] }),
      double: simulate({ market, orders, candidate, from, to, costs: protocol.costs[1] }),
      triple: simulate({ market, orders, candidate, from, to, costs: protocol.costs[2] }),
      managed: simulate({ market, orders, candidate, from, to, mode: 'managed', costs: protocol.costs[0] }),
      master1x: simulate({ market, orders, candidate, from, to, leverage: 1, costs: protocol.costs[0] }),
      neighbor: simulate({ market, orders: makeOrders(features, neighbor), candidate: neighbor, from, to, costs: protocol.costs[0] }),
      exposed: simulate({ market, orders, candidate, from: recentFrom, to: recentTo, costs: protocol.costs[0] })
    };
    const groups = [];
    for (const horizonDays of protocol.cohorts.horizonDays) {
      for (const costs of protocol.costs.slice(0, 2)) {
        const cohorts = [];
        for (let start = from; start < to; start += 7 * DAY) {
          cohorts.push(challenge({ market, orders, candidate, from: start, dataEnd: to, horizonDays, costs }));
        }
        groups.push(cohortSummary(cohorts, horizonDays, costs));
        cohortLedgers[`${candidate.id}:${horizonDays}:${costs.id}`] = cohorts;
      }
    }
    for (const trade of cases.base.trades) csv.push(csv[0].map((field) => field === 'candidate' ? candidate.id : trade[field]));
    for (const day of cases.base.daily) dailyCsv.push(dailyCsv[0].map((field) => field === 'candidate' ? candidate.id : day[field]));
    const result = {
      ...finalist, neighborCandidate: neighbor,
      cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, compact(v)])),
      equity: cases.base.daily, cohortGroups: groups,
      assessment: finalAssessment(finalist, cases.base.metrics)
    };
    results.push(result); ledgers[candidate.id] = cases;
    console.log(`FINAL ${candidate.id}: ${cases.base.metrics.netReturnPct.toFixed(2)}%, PF ${cases.base.metrics.profitFactor?.toFixed(3)}, ${cases.base.metrics.tradeCount} trades, ${groups[2].outcomes.pass}/${groups[2].starts} 120-day proxy passes`);
  }
  const downloadable = {
    developmentLedgers: { file: 'development-ledgers.json.gz' },
    finalLedgers: { file: 'final-ledgers.json.gz', ...await archive(join(directory, 'final-ledgers.json.gz'), ledgers) },
    cohortLedgers: { file: 'cohort-ledgers.json.gz', ...await archive(join(directory, 'cohort-ledgers.json.gz'), cohortLedgers) }
  };
  await writeFile(join(directory, 'final-trades.csv'), csv.map((row) => row.join(',')).join('\n') + '\n');
  await writeFile(join(directory, 'final-daily.csv'), dailyCsv.map((row) => row.join(',')).join('\n') + '\n');
  const report = {
    schemaVersion: 1, protocolId: protocol.id, warning: protocol.warning,
    generatedAt: provenance.retrievedAt, generatedAtMeaning: 'Frozen data acquisition timestamp; output is deterministic, not a live research refresh.',
    account: protocol.account, protocolSha256: hash(protocol), sourceSha256: selection.sourceSha256,
    selectionSha256: hash(selection), marketSha256: provenance.marketSha256,
    data: { from: provenance.from, to: provenance.to, barsPerSymbol: provenance.barsPerSymbol, expectedBarsPerSymbol: provenance.expectedBarsPerSymbol,
      gapUtcDates: provenance.gapUtcDates, coveragePolicy: provenance.coveragePolicy, recovered15mBars: provenance.recovered15mBars, missing15mSourceBars: provenance.missing15mSourceBars },
    splits: protocol.splits, costs: protocol.costs, development, selection, finalists: results,
    benchmarks: Object.fromEntries(Object.keys(protocol.splits).map((split) => {
      const [start, end] = period(split);
      return [split, buyHold(market, start, end)];
    })),
    assessment: selection.eligibleCount === 0 ? 'NONE MEETS CRITERIA. No candidate passed the preregistered development gates. Finalists are diagnostic controls, not recommended or activated strategies.' :
      results.every((r) => !r.cases.base.metrics.complete || r.cases.base.metrics.netReturnPct <= 0 ||
        (r.cases.base.metrics.profitFactor ?? 0) < 1.1 || !r.eligible) ? 'No development-qualified candidate delivered a complete final result meeting profitability criteria.' :
        'Some conditional historical evidence, not proof of profitability or a verified FundingPips pass.',
    limitations: [...protocol.limitations, provenance.amendments.find((a) => a.id === 'A3').biasDisclosure],
    sources: protocol.sources, downloads: downloadable,
    attemptedRuns: { development: protocol.candidates.length * 5, finalStandalone: selection.finalists.length * 7,
      cohortPaths: results.reduce((n, r) => n + r.cohortGroups.reduce((s, g) => s + g.starts, 0), 0) },
    reproduction: 'node src/fundingpips/study.js --verify; uses committed real-data cache, never fetches final again or selects on it.'
  };
  await writeJson(join(directory, 'results.json'), report);
  await writeJson(join(directory, 'results-hash.json'), { algorithm: 'SHA256(JSON.stringify(parsed results.json))', sha256: hash(report) });
  return report;
}

export async function verifyStudy() {
  const temporary = await mkdtemp(join(tmpdir(), 'fundingpips-reproduce-'));
  try {
    await developmentStudy({ directory: temporary });
    const actual = await finalStudy({ directory: temporary });
    const expected = await readJson(join(ROOT, 'results-hash.json'));
    if (hash(actual) !== expected.sha256) throw new Error('Research reproduction differs from published results');
    console.log(`Exact research reproduction: ${expected.sha256}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const action = process.argv.includes('--development') ? developmentStudy :
    process.argv.includes('--final') ? finalStudy : process.argv.includes('--verify') ? verifyStudy : null;
  if (!action) { console.error('Choose --development, --final, or --verify'); process.exitCode = 1; }
  else action().catch((error) => { console.error(error); process.exitCode = 1; });
}
