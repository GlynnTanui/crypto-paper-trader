import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG, STEP, WARMUP, iso } from '../src/config.js';
import { readJson, writeJson } from '../src/storage.js';
import { run } from '../src/run.js';
import { snapshot } from '../src/publish.js';
import { build } from '../src/build.js';
import { validateState } from '../src/engine.js';

const NOW = Date.parse('2026-01-03T12:07:00.000Z');
function provider(from, to) {
  return Object.fromEntries(CONFIG.symbols.map((symbol) => [symbol,
    Array.from({ length: (to - from) / STEP }, (_, i) => ({
      time: iso(from + i * STEP), open: 100, high: 101, low: 99, close: 100, volume: 1
    }))
  ]));
}

test('runtime persists clean initialization, reloads idempotently and publishes authentic schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  try {
    const first = await run({ directory, now: NOW, provider });
    const second = await run({ directory, now: NOW, provider });
    assert.deepEqual(second, first);
    const state = await readJson(join(directory, 'state.json'));
    validateState(state);
    const output = await readJson(join(directory, 'snapshot.json'));
    assert.equal(output.account.equity, 10000);
    assert.equal(output.meta.status, 'healthy');
    assert.equal(output.positions.length, 0);
    assert.match(output.meta.catchUp, /Hypothetical/);
    assert.equal(output.meta.marketAsOf, '2026-01-03T12:00:00.000Z');
    assert.equal(output.meta.nextExpectedUpdate, '2026-01-03T12:22:00.000Z');
    assert.equal(output.config.riskPerTrade, 0.0025);
    assert.equal(state.equityHistory.length, 1);
    await run({ directory, now: NOW + STEP, provider });
    assert.equal((await readJson(join(directory, 'state.json'))).equityHistory.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('next expected update follows the offset UTC schedule, not the manual dispatch time', () => {
  const output = snapshot(null, {
    status: 'initializing', generatedAt: '2026-01-03T23:58:30.000Z', message: 'Waiting'
  });
  assert.equal(output.meta.nextExpectedUpdate, '2026-01-04T00:07:00.000Z');
});

test('network failure never advances bars or cash; authenticated pause persists and error publishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  try {
    const first = await run({ directory, now: NOW, provider });
    await assert.rejects(run({ directory, control: 'pause', now: NOW + STEP,
      provider: async () => { throw new Error('Provider unavailable'); } }), /Provider unavailable/);
    const state = await readJson(join(directory, 'state.json'));
    assert.equal(state.paused, true);
    assert.equal(state.lastProcessed, first.lastProcessed);
    assert.equal(state.cash, first.cash);
    const output = await readJson(join(directory, 'snapshot.json'));
    assert.equal(output.meta.status, 'error');
    assert.equal(output.meta.lastSuccessAt, iso(NOW));
    assert.match(output.meta.message, /Provider unavailable/);
    await run({ directory, control: 'resume', now: NOW + STEP, provider });
    assert.equal((await readJson(join(directory, 'state.json'))).paused, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt or missing persisted account cannot silently reset or publish success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  try {
    await run({ directory, now: NOW, provider });
    const state = await readJson(join(directory, 'state.json'));
    state.cash = 15000;
    await writeJson(join(directory, 'state.json'), state);
    await assert.rejects(run({ directory, now: NOW + STEP, provider }), /reconciliation/);
    assert.equal((await readJson(join(directory, 'health.json'))).status, 'error');
    await assert.rejects(build({ directory, output: join(directory, 'site') }), /reconciliation/);
    await rm(join(directory, 'state.json'));
    await assert.rejects(run({ directory, now: NOW + STEP, provider }), /refusing to reset/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime rejects stale data, invalid controls and excessive catch-up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  try {
    await assert.rejects(run({ directory, now: NOW, provider: (from, to) => provider(from - STEP * 4, to - STEP * 4) }), /Stale/);
    await run({ directory, now: NOW, provider });
    await assert.rejects(run({ directory, now: NOW, control: 'reset', provider }), /Unknown/);
    await assert.rejects(run({ directory, now: NOW + 8 * 24 * 60 * 60_000, provider }), /7 days/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('static build emits only public snapshot and research, never raw ledger files or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  try {
    await run({ directory, now: NOW, provider });
    await writeJson(join(directory, 'research.json'), { assessment: 'No validated profitability', holdout: null });
    const output = join(directory, 'site');
    await build({ directory, output });
    const data = await readJson(join(output, 'data', 'snapshot.json'));
    assert.equal(data.meta.schemaVersion, 1);
    assert.equal(data.account.startingBalance, 10000);
    assert.ok(data.equityHistory.length);
    const html = await readFile(join(output, 'index.html'), 'utf8');
    const js = await readFile(join(output, 'app.js'), 'utf8');
    assert.match(html, /PAPER/i);
    assert.match(html, /styles\.css/);
    assert.match(html, /app\.js/);
    assert.match(js, /snapshot\.json/);
    assert.match(js, /research\.json/);
    assert.doesNotMatch(js, /localStorage|sessionStorage|ghp_|github_pat_|apiKey|method:\s*['"]POST/i);
    await assert.rejects(readFile(join(output, 'data', 'state.json')), /ENOENT/);
    assert.equal(snapshot(null, { status: 'initializing', generatedAt: iso(NOW), message: 'Waiting' }).account, null);
    assert.equal(WARMUP, 150);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
