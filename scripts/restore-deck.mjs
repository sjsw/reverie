#!/usr/bin/env node
/**
 * Re-downloads the exact reviewed deck recorded in public/cards/manifest.json.
 *
 * This is NOT the same as `fetch-cards`. That one searches the museum APIs and
 * builds a fresh, unreviewed selection; this one fetches precisely the 300
 * works that were inspected by hand, by their stored source URLs. The manifest
 * is committed to git, so the reviewed deck is reproducible without keeping
 * ~90 MB of images in the repository.
 *
 * Usage:  npm run restore-deck [-- --force]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'cards');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const FORCE = process.argv.includes('--force');

const UA = 'reverie-deck-restore/1.0 (self-hosted party game)';

async function download(card) {
  const dest = path.join(OUT_DIR, card.file);
  if (!FORCE) {
    try {
      const st = await fs.stat(dest);
      if (st.size > 2048) return 'cached';
    } catch {
      /* not present */
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(card.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2048) throw new Error('suspiciously small image');
      await fs.writeFile(dest, buf);
      return 'downloaded';
    } catch (err) {
      if (attempt === 2) {
        console.warn(`  ! ${card.key} (${card.artist}): ${err.message}`);
        return 'failed';
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return 'failed';
}

/** Run `worker` over `items` with bounded concurrency. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) results.push(await worker(items[cursor++]));
    }),
  );
  return results;
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  } catch {
    console.error(
      `\nCannot read ${path.relative(ROOT, MANIFEST)}.\n` +
        'It is committed to the repository — restore it from git before running this.\n',
    );
    process.exit(1);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`Restoring ${manifest.cards.length} reviewed cards…`);

  const results = await pool(manifest.cards, 8, download);
  const tally = results.reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});

  console.log(
    `\n✓ ${tally.downloaded ?? 0} downloaded, ${tally.cached ?? 0} already present` +
      (tally.failed ? `, ${tally.failed} FAILED` : ''),
  );

  if (tally.failed) {
    console.error(
      '\n⚠ Some cards could not be fetched. The museums occasionally move images.\n' +
        '  The server needs at least 48 cards to start; re-run to retry the failures.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
