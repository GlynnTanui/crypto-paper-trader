import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, STEP, WARMUP, iso } from './config.js';
import { createState, validateState, applyControl, initializeForward, processMarket, activity } from './engine.js';
import { fetchMarket } from './market.js';
import { readJson, writeJson } from './storage.js';
import { snapshot } from './publish.js';

export async function run({ directory = 'runtime', control = 'evaluate', now = Date.now(), provider = fetchMarket } = {}) {
  const generatedAt = iso(now);
  const statePath = join(directory, 'state.json');
  const healthPath = join(directory, 'health.json');
  const snapshotPath = join(directory, 'snapshot.json');
  let state = await readJson(statePath, { optional: true });
  const previousHealth = await readJson(healthPath, { optional: true });
  let controlApplied = false;
  try {
    if (state) validateState(state);
    else if (previousHealth?.lastSuccessAt) throw new Error('Persisted account is missing; refusing to reset virtual funds');
    else state = createState(generatedAt);
    applyControl(state, control, generatedAt);
    controlApplied = true;
    // Wait two minutes beyond a bar boundary before considering a candle publishable.
    const to = Math.floor((now - 120_000) / STEP) * STEP;
    const from = state.lastProcessed
      ? Date.parse(state.lastProcessed) - WARMUP * STEP
      : to - (WARMUP + 1) * STEP;
    if (state.lastProcessed && to - Date.parse(state.lastProcessed) > 7 * 24 * 60 * 60_000) {
      throw new Error('More than 7 days of missing bars. Account frozen; operator must investigate before explicit recovery.');
    }
    const market = await provider(from, to, { now, fresh: true });
    const next = state.lastProcessed ? processMarket(state, market, { now, fresh: true }) : initializeForward(state, market, now);
    if (next.lastProcessed !== state.lastProcessed && state.lastProcessed) {
      const bars = (Date.parse(next.lastProcessed) - Date.parse(state.lastProcessed)) / STEP;
      activity(next, generatedAt, `Processed ${bars} closed 15-minute bar(s) as hypothetical replay; no real orders.`);
    }
    validateState(next);
    if (JSON.stringify(next.fills.slice(0, state.fills.length)) !== JSON.stringify(state.fills)) {
      throw new Error('Existing immutable fills were modified');
    }
    const health = {
      status: 'healthy', generatedAt, lastSuccessAt: generatedAt,
      message: next.paused ? 'New entries paused; existing position exits remain managed.' :
        next.riskHalt ? `Risk circuit breaker active: ${next.riskHalt}` : 'Public Coinbase data processed. Scheduled execution may be delayed.'
    };
    await writeJson(statePath, next);
    await writeJson(healthPath, health);
    await writeJson(snapshotPath, snapshot(next, health));
    console.log(JSON.stringify({ status: health.status, lastProcessed: next.lastProcessed, equity: next.equity, fills: next.fills.length }));
    return next;
  } catch (error) {
    console.error(`Simulation failed closed: ${error.message}`);
    const health = { status: 'error', generatedAt, lastSuccessAt: previousHealth?.lastSuccessAt ?? null, message: error.message };
    await writeJson(healthPath, health);
    // Validated authenticated pause/resume remains durable even when market data is unavailable.
    if (controlApplied && control !== 'evaluate') {
      validateState(state);
      await writeJson(statePath, state);
    }
    if (controlApplied) await writeJson(snapshotPath, snapshot(state, health));
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run({ directory: process.env.DATA_DIR ?? 'runtime', control: process.env.CONTROL ?? 'evaluate' })
    .catch(() => { process.exitCode = 1; });
}
