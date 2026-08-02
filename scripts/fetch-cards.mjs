#!/usr/bin/env node
/**
 * Builds the card deck from open-access museum collections.
 *
 * Sources:
 *   - Art Institute of Chicago  (api.artic.edu, CC0 metadata, IIIF images)
 *   - The Metropolitan Museum   (collectionapi.metmuseum.org)
 *
 * Both expose a public-domain flag; we only ever download images they have
 * explicitly cleared. Output goes to public/cards/ plus a manifest.json that
 * carries attribution for the in-game credits screen.
 *
 * Usage:  npm run fetch-cards -- [--target 300] [--force]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'cards');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const args = process.argv.slice(2);
const TARGET = Number(argFlag('--target') ?? 300);
const FORCE = args.includes('--force');

function argFlag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

/**
 * Artists with the dreamlike, symbol-heavy register the game needs.
 *
 * This list is deliberately weighted towards landscape, architecture, nature
 * and narrative illustration, because the deck has to be safe to put on a
 * screen in an office. Nineteenth-century symbolist and academic art is
 * saturated with nudes, so the artists whose corpus is largely figure studies
 * or erotica (Rops, Klinger, Burne-Jones, Beardsley, Gauguin, Fantin-Latour,
 * and Dürer's and Goya's religious/allegorical work) are left out entirely
 * rather than filtered after the fact — it is far easier to keep them out than
 * to catch every one on the way in.
 *
 * Fuzzy search will happily return a Corot landscape for a miss, so every
 * result is checked against `match` before we keep it.
 */
const AIC_QUERIES = [
  // Japanese landscape, weather, birds and flowers — the safest large corpus,
  // and a great visual fit.
  { q: 'Utagawa Hiroshige', match: /hiroshige/i },
  { q: 'Katsushika Hokusai', match: /hokusai/i },
  { q: 'Utagawa Kuniyoshi', match: /kuniyoshi/i },
  { q: 'Tsukioka Yoshitoshi', match: /yoshitoshi/i },
  // Must be the full name: a bare /eisen/ also matches Charles Eisen, an
  // 18th-century French illustrator who worked in erotica.
  { q: 'Keisai Eisen', match: /keisai eisen/i },
  { q: 'Utagawa Kunisada', match: /kunisada/i },
  { q: 'Ohara Koson', match: /koson/i },
  { q: 'Hiroshi Yoshida', match: /yoshida/i },

  // Architectural fantasy and cityscape — no figures to speak of.
  { q: 'Giovanni Battista Piranesi', match: /piranesi/i },
  { q: 'Charles Meryon', match: /meryon/i },

  // Fantastical landscape and narrative illustration.
  { q: 'Rodolphe Bresdin', match: /bresdin/i },
  { q: 'Gustave Doré', match: /dor[eé]/i },
  { q: 'Arthur Rackham', match: /rackham/i },
  { q: 'Walter Crane', match: /walter crane/i },
  { q: 'Winsor McCay', match: /mccay/i },
  { q: 'Ivan Bilibin', match: /bilibin/i },

  // Landscape painting.
  { q: 'Théodore Rousseau', match: /rousseau/i },
  { q: 'Camille Corot', match: /corot/i },
  { q: 'Vincent van Gogh', match: /van gogh/i },
  // "Friedrich" is a common German given name — matching it alone pulled in
  // Schinkel, Overbeck, Tischbein and half a dozen others.
  { q: 'Caspar David Friedrich', match: /caspar david friedrich/i },

  // Decorative and satirical work — clothed by convention.
  { q: 'Alphonse Mucha', match: /mucha/i },
  { q: 'Honoré Daumier', match: /daumier/i },

  // Redon's flower pieces and dream-heads are the single best visual match for
  // the game; his figure studies are screened out by title and by review.
  { q: 'Odilon Redon', match: /redon/i },
];

const MET_QUERIES = ['Ohara Koson', 'Ivan Bilibin', 'Arthur Rackham', 'Edmund Dulac'];

/**
 * Second net, on top of the artist selection: titles that signal a nude or
 * erotic subject. Deliberately broad — over-filtering costs a few cards from a
 * pool of hundreds, while under-filtering puts a nude on a meeting-room screen.
 */
const UNSAFE_TITLE = new RegExp(
  [
    'nude', 'naked', 'nu\\b', 'undress', 'disrob', 'unclothed',
    'bather', 'bathing', 'bath\\b', 'odalisque', 'harem',
    'venus', 'leda', 'danae', 'danaë', 'diana', 'susanna', 'bathsheba',
    'adam and eve', 'temptation', 'garden of eden', 'original sin',
    'nymph', 'satyr', 'faun', 'bacchan', 'sappho', 'lesbia',
    'three graces', 'judgment of paris', 'birth of venus',
    'courtesan', 'brothel', 'prostitut', 'harlot', 'seduc', 'erotic',
    'lust', 'lover', 'embrace', 'kiss\\b', 'phallus', 'torso',
    'life study', 'figure study', 'academie', 'académie', 'anatomy',
    'martyrdom', 'flagellat', 'crucifix', 'hell\\b', 'damned', 'inferno',
  ].join('|'),
  'i',
);

/** Card keys removed during visual review; never re-downloaded. */
async function loadExclusions() {
  try {
    const raw = await fs.readFile(path.join(ROOT, 'scripts', 'excluded-cards.json'), 'utf8');
    return new Set(JSON.parse(raw).excluded ?? []);
  } catch {
    return new Set();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'reverie-card-fetcher/1.0 (self-hosted party game)' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) {
        console.warn(`  ! giving up on ${url}: ${err.message}`);
        return null;
      }
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

/** Portrait or near-square crops read best as cards; skip extreme panoramas. */
function acceptableRatio(w, h) {
  if (!w || !h) return true; // unknown, let it through
  const r = w / h;
  return r > 0.45 && r < 1.9;
}

let exclusions = new Set();

async function collectAIC() {
  const found = [];
  for (const { q, match } of AIC_QUERIES) {
    const url =
      'https://api.artic.edu/api/v1/artworks/search?' +
      new URLSearchParams({
        q,
        fields: 'id,title,image_id,artist_title,date_display,is_public_domain,thumbnail',
        limit: '100',
      });
    const data = await getJSON(url);
    const all = (data?.data ?? []).filter(
      (a) =>
        a.is_public_domain &&
        a.image_id &&
        a.artist_title &&
        match.test(a.artist_title) &&
        acceptableRatio(a.thumbnail?.width, a.thumbnail?.height),
    );
    const hits = all.filter(
      (a) => !UNSAFE_TITLE.test(a.title ?? '') && !exclusions.has(`aic-${a.id}`),
    );
    const dropped = all.length - hits.length;
    console.log(`  AIC ${q}: ${hits.length} usable${dropped ? ` (${dropped} screened out)` : ''}`);
    for (const a of hits) {
      found.push({
        key: `aic-${a.id}`,
        url: `https://www.artic.edu/iiif/2/${a.image_id}/full/800,/0/default.jpg`,
        title: a.title,
        artist: a.artist_title,
        date: a.date_display ?? '',
        source: 'Art Institute of Chicago',
        link: `https://www.artic.edu/artworks/${a.id}`,
      });
    }
    await sleep(120);
  }
  return found;
}

async function collectMet() {
  const found = [];
  for (const q of MET_QUERIES) {
    const search = await getJSON(
      'https://collectionapi.metmuseum.org/public/collection/v1/search?' +
        new URLSearchParams({ q, artistOrCulture: 'true', hasImages: 'true' }),
    );
    const ids = (search?.objectIDs ?? []).slice(0, 40);
    let kept = 0;
    for (const id of ids) {
      const o = await getJSON(
        `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
      );
      if (!o?.isPublicDomain || !o.primaryImageSmall) continue;
      if (UNSAFE_TITLE.test(o.title ?? '') || exclusions.has(`met-${o.objectID}`)) continue;
      found.push({
        key: `met-${o.objectID}`,
        url: o.primaryImageSmall,
        title: o.title || 'Untitled',
        artist: o.artistDisplayName || o.culture || 'Unknown',
        date: o.objectDate ?? '',
        source: 'The Metropolitan Museum of Art',
        link: o.objectURL,
      });
      kept++;
      await sleep(60);
    }
    console.log(`  Met ${q}: ${kept} usable`);
  }
  return found;
}

async function download(card) {
  const file = `${card.key}.jpg`;
  const dest = path.join(OUT_DIR, file);
  if (!FORCE) {
    try {
      const st = await fs.stat(dest);
      if (st.size > 2048) return { ...card, file };
    } catch {
      /* not cached yet */
    }
  }
  try {
    const res = await fetch(card.url, {
      headers: { 'User-Agent': 'reverie-card-fetcher/1.0 (self-hosted party game)' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2048) return null; // placeholder / error image
    await fs.writeFile(dest, buf);
    return { ...card, file };
  } catch (err) {
    console.warn(`  ! ${card.key}: ${err.message}`);
    return null;
  }
}

/** Run `worker` over `items` with bounded concurrency. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        const out = await worker(item);
        if (out) results.push(out);
      }
    }),
  );
  return results;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  exclusions = await loadExclusions();
  if (exclusions.size) console.log(`Honouring ${exclusions.size} manually excluded cards.`);

  console.log('Searching open-access collections…');
  const [aic, met] = await Promise.all([collectAIC(), collectMet()]);

  // De-duplicate, then interleave sources so one artist can't dominate.
  const byKey = new Map();
  for (const c of [...aic, ...met]) byKey.set(c.key, c);
  const candidates = [...byKey.values()];

  const byArtist = new Map();
  for (const c of candidates) {
    const list = byArtist.get(c.artist) ?? [];
    list.push(c);
    byArtist.set(c.artist, list);
  }
  const ordered = [];
  for (let i = 0; ordered.length < candidates.length; i++) {
    let added = false;
    for (const list of byArtist.values()) {
      if (list[i]) {
        ordered.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }

  console.log(
    `\nFound ${candidates.length} candidates from ${byArtist.size} artists. ` +
      `Downloading up to ${TARGET}…`,
  );

  const picked = ordered.slice(0, Math.ceil(TARGET * 1.15)); // headroom for failures
  const cards = (await pool(picked, 8, download)).slice(0, TARGET);

  cards.sort((a, b) => a.key.localeCompare(b.key));
  await fs.writeFile(
    MANIFEST,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        count: cards.length,
        note: 'All images are open-access/public-domain works as flagged by their source institution.',
        cards,
      },
      null,
      2,
    ),
  );

  // Drop any stale images that are no longer in the manifest.
  const keep = new Set(cards.map((c) => c.file));
  for (const f of await fs.readdir(OUT_DIR)) {
    if (f.endsWith('.jpg') && !keep.has(f)) await fs.unlink(path.join(OUT_DIR, f));
  }

  const artists = new Set(cards.map((c) => c.artist));
  console.log(`\n✓ Deck ready: ${cards.length} cards from ${artists.size} artists`);
  console.log(`  images   → public/cards/`);
  console.log(`  manifest → public/cards/manifest.json`);
  console.log(
    '\n⚠ The committed deck was reviewed image-by-image for workplace suitability.\n' +
      '  Re-running this script can pull in works nobody has looked at yet, because\n' +
      '  the museums keep changing what their search returns. If you re-fetch, review\n' +
      '  the new images and add anything unsuitable to scripts/excluded-cards.json.',
  );
  if (cards.length < 60) {
    console.warn('\n⚠ Fewer than 60 cards — games will recycle the deck quickly.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
