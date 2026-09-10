import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { hash } from '../config.js';
import { readJson } from '../storage.js';
import { ROOT } from './data.js';
import { developmentStudy, finalStudy } from './study.js';

export async function verifyPortable() {
  const directory = await mkdtemp(join(tmpdir(), 'fundingpips-portable-'));
  try {
    const published = await readJson(join(ROOT, 'results.json'));
    const expected = await readJson(join(ROOT, 'results-hash.json'));
    assert.equal(hash(published), expected.sha256, 'Published report hash mismatch');
    await developmentStudy({ directory });
    const reproduced = await finalStudy({ directory });
    assert.deepEqual(Object.keys(reproduced.downloads), Object.keys(published.downloads));
    for (const key of Object.keys(published.downloads)) {
      const reference = published.downloads[key], actual = reproduced.downloads[key];
      assert.equal(actual.file, reference.file, 'Changed evidence archive path');
      const frozenBytes = await readFile(join(ROOT, reference.file));
      const reproducedBytes = await readFile(join(directory, actual.file));
      if (reference.sha256) {
        assert.equal(createHash('sha256').update(frozenBytes).digest('hex'), reference.sha256, 'Published download checksum mismatch');
        assert.equal(frozenBytes.length, reference.bytes, 'Published download size mismatch');
      }
      // gzip headers/compression streams can differ across OS/zlib versions; their financial payload may not.
      assert.deepEqual(gunzipSync(reproducedBytes), gunzipSync(frozenBytes), `Financial evidence differs in ${reference.file}`);
    }
    const { downloads: publishedTransport, ...publishedEvidence } = published;
    const { downloads: reproducedTransport, ...reproducedEvidence } = reproduced;
    assert.deepEqual(reproducedEvidence, publishedEvidence, 'Reproduced report fields differ');
    const canonical = { ...reproduced, downloads: publishedTransport };
    assert.equal(hash(canonical), expected.sha256, 'Canonical report hash mismatch');
    console.log(`Exact uncompressed ledgers and report reproduced: ${expected.sha256}. Published archive transport checksums verified separately.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyPortable().catch((error) => { console.error(error); process.exitCode = 1; });
}
