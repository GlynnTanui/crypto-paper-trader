import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './storage.js';
import { snapshot } from './publish.js';
import { validateState } from './engine.js';
import { iso } from './config.js';

export async function build({ directory = 'runtime', output = 'dist', now = Date.now() } = {}) {
  const state = await readJson(join(directory, 'state.json'), { optional: true });
  const health = await readJson(join(directory, 'health.json'), { optional: true }) ?? {
    status: 'initializing', generatedAt: iso(now), message: 'Waiting for the first successful public-data run.'
  };
  if (state) validateState(state);
  if (!state && health.lastSuccessAt) throw new Error('Missing previously initialized account');
  const research = await readJson(join(directory, 'research.json'), { optional: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'data'), { recursive: true });
  await cp('web', output, { recursive: true });
  await writeJson(join(output, 'data', 'snapshot.json'), snapshot(state, health));
  if (research) await writeJson(join(output, 'data', 'research.json'), research);
  console.log(`Built public read-only dashboard in ${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build({ directory: process.env.DATA_DIR ?? 'runtime', output: process.env.OUTPUT_DIR ?? 'dist' })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
