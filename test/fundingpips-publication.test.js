import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readJson } from '../src/storage.js';
import { hash, STEP, iso } from '../src/config.js';
import { ROOT, loadData, protocol } from '../src/fundingpips/data.js';

test('published research archive, all candidates, selection and scenario totals reconcile', async () => {
  const report = await readJson(join(ROOT, 'results.json'));
  const expected = await readJson(join(ROOT, 'results-hash.json'));
  const selection = await readJson(join(ROOT, 'selection.json'));
  assert.equal(hash(report), expected.sha256);
  assert.equal(hash(selection), report.selectionSha256);
  assert.equal(report.account.initial, 5000);
  assert.equal(report.protocolSha256, hash(protocol));
  assert.match(report.warning, /NOT VERIFIED FUNDINGPIPS PASS/);
  assert.deepEqual(report.development.map((row) => row.candidate), protocol.candidates);
  assert.deepEqual(report.finalists.map((f) => f.candidate), selection.finalists.map((f) => f.candidate));
  assert.equal(report.attemptedRuns.development, 80);
  assert.equal(report.attemptedRuns.finalStandalone, 14);
  for (const finalist of report.finalists) {
    for (const group of finalist.cohortGroups) {
      assert.equal(Object.values(group.outcomes).reduce((a, b) => a + b, 0), group.starts);
      assert.equal(Object.values(group.fullyObservedOutcomes).reduce((a, b) => a + b, 0), group.fullyObservedOpportunities);
      assert.equal(group.cohorts.length, group.starts);
      for (const cohort of group.cohorts) {
        if (cohort.phase2) {
          assert.equal(cohort.phase2.initial, 5000);
          assert.ok(Date.parse(cohort.phase2.from) > Date.parse(cohort.phase1.stoppedAt));
        }
        if (cohort.outcome === 'pass') {
          assert.ok(cohort.phase1.entryTradingDays >= 3 && cohort.phase2.entryTradingDays >= 3);
          assert.ok(cohort.phase1.endingBalance >= 5400 && cohort.phase2.endingBalance >= 5250);
        }
      }
    }
  }
  const bundle = report.downloads.finalLedgers;
  const bytes = await readFile(join(ROOT, bundle.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), bundle.sha256);
  const ledgers = JSON.parse(gunzipSync(bytes));
  for (const runs of Object.values(ledgers)) {
    for (const run of Object.values(runs)) {
      const pnl = run.trades.reduce((sum, trade) => sum + trade.netPnl, 0);
      const openFee = run.metrics.unresolvedPosition?.entryFee ?? 0;
      assert.ok(Math.abs(run.metrics.endingBalance - 5000 - pnl + openFee) < 1e-7);
      assert.ok(run.trades.every((trade) => trade.freeMarginAtEntry >= 0));
    }
  }
});

test('real-data provenance declares every sparse timestamp and retains genuine repair evidence', async () => {
  const { market, provenance } = await loadData();
  const missing = new Set(provenance.pages.flatMap((p) => p.gaps.map((g) => g.time)));
  const timestamps = new Set(market['BTC-USD'].map((bar) => bar.time));
  for (let t = Date.parse(protocol.data.from); t < Date.parse(protocol.data.to); t += STEP) {
    assert.equal(timestamps.has(iso(t)), !missing.has(iso(t)));
  }
  for (const page of provenance.pages) {
    for (const repair of page.repairs) {
      assert.equal(repair.source.length, 3);
      assert.deepEqual(repair.source.map((b) => Date.parse(b.time)),
        [0, 300000, 600000].map((offset) => Date.parse(repair.time) + offset));
      const actual = market[page.symbol].find((b) => b.time === repair.time);
      assert.equal(actual.open, repair.source[0].open);
      assert.equal(actual.close, repair.source[2].close);
      assert.equal(actual.high, Math.max(...repair.source.map((b) => b.high)));
      assert.equal(actual.low, Math.min(...repair.source.map((b) => b.low)));
      assert.equal(actual.volume, repair.source.reduce((sum, b) => sum + b.volume, 0));
    }
  }
});
