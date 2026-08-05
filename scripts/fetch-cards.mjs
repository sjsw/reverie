#!/usr/bin/env node
/**
 * Builds the card deck from the Art Institute of Chicago's open-access
 * collection (api.artic.edu — CC0 metadata, IIIF images). Only works the
 * museum has explicitly flagged as public domain are ever downloaded.
 *
 * The deck is assembled from *named series* rather than from artists. This
 * matters more than it sounds: searching "Odilon Redon" returns his flower
 * paintings and portraits alongside his dream lithographs, and searching an
 * artist the museum does not hold returns fuzzy nonsense — a search for
 * "Grandville" once returned Manet. Searching "Carceri d'invenzione" and then
 * *verifying the returned title actually matches* gives the surreal, invented
 * imagery the game needs, with no false positives.
 *
 * Output: <out>/ images plus manifest.json carrying attribution for the
 * in-game credits screen.
 *
 * Usage:
 *   npm run fetch-cards -- [--target 300] [--out public/cards] [--force]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function argFlag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

const TARGET = Number(argFlag('--target') ?? 300);
const FORCE = args.includes('--force');
const OUT_DIR = path.resolve(ROOT, argFlag('--out') ?? path.join('public', 'cards'));
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const UA = 'reverie-card-fetcher/1.0 (self-hosted party game)';

/**
 * The deck, as a set of named series.
 *
 * `q`      — what to ask the search for.
 * `match`  — the returned *title* must match this, or the result is discarded.
 *            Search is fuzzy and will pad results with unrelated works.
 * `artist` — optional extra guard where a title word alone is too generic
 *            ("ghost", "dream").
 * `cap`    — maximum kept, so one large series cannot dominate the deck.
 *
 * `tone` is documentation, not logic: `strange` is the surreal core, `lyrical`
 * keeps the deck from becoming relentlessly macabre. Dixit's own art is
 * whimsical-odd rather than grim, and a deck of nothing but skeletons and
 * prisons would miss it.
 */
const SERIES = [
  // ---- Invented architecture: impossible spaces, no figures to speak of.
  { q: "Carceri d'invenzione Imaginary Prisons", match: /carceri|imaginary prison/i, cap: 32, tone: 'strange' },

  // ---- Japanese ghosts, demons and apparitions.
  { q: 'One Hundred Ghost Tales Hyaku Monogatari', match: /hyaku monogatari|one hundred ghost/i, cap: 12, tone: 'strange' },
  { q: 'New Forms of Thirty-Six Ghosts Yoshitoshi', match: /thirty-?six ghosts/i, cap: 22, tone: 'strange' },
  { q: 'One Hundred Aspects of the Moon Yoshitoshi', match: /aspects of the moon/i, cap: 22, tone: 'lyrical' },
  { q: 'Kuniyoshi ghost demon skeleton apparition', match: /ghost|demon|skeleton|spectre|specter|apparition|monster|goblin/i, artist: /kuniyoshi|yoshitoshi|kunisada|hokusai|shun'?ei/i, cap: 30, tone: 'strange' },

  // ---- Redon's noirs: the single best visual match for the game.
  { q: 'Odilon Redon To Edgar Poe', match: /edgar poe/i, cap: 14, tone: 'strange' },
  { q: 'Odilon Redon Les Origines', match: /origines|origins/i, artist: /redon/i, cap: 12, tone: 'strange' },
  { q: 'Odilon Redon Songes Dreams', match: /songes|dream/i, artist: /redon/i, cap: 12, tone: 'strange' },
  { q: 'Odilon Redon Temptation of Saint Anthony', match: /temptation of (saint|st)\.? ?anthony|chimera|eyeball/i, artist: /redon/i, cap: 14, tone: 'strange' },
  { q: 'Odilon Redon flowers bouquet', match: /flower|bouquet|vase|butterfl/i, artist: /redon/i, cap: 10, tone: 'lyrical' },

  // ---- Goya's fantasy series: grotesque, dreamlike, mostly clothed.
  { q: 'Los Caprichos Goya', match: /caprichos/i, cap: 36, tone: 'strange' },
  { q: 'Los Disparates Proverbios Goya', match: /disparates|proverbios|folly/i, artist: /goya/i, cap: 24, tone: 'strange' },

  // ---- Literary illustration: Poe, Dante, the Apocalypse.
  { q: 'The Raven Poe illustration', match: /raven/i, cap: 18, tone: 'strange' },

  // ---- Fantastical landscape.
  { q: 'Rodolphe Bresdin Comedy of Death', match: /com[eé]die de la mort|comedy of death|fantastic|enchanted/i, artist: /bresdin/i, cap: 10, tone: 'strange' },
  { q: 'Rodolphe Bresdin', match: /./, artist: /bresdin/i, cap: 20, tone: 'strange' },
  { q: 'Charles Meryon Paris etching', match: /./, artist: /meryon/i, cap: 20, tone: 'strange' },

  // ---- Lyrical counterweight: weather, moonlight, birds and flowers.
  { q: 'Hiroshige moonlight night snow rain', match: /moon|night|snow|rain|mist|fog|evening|twilight/i, artist: /hiroshige|hokusai|eisen|koson/i, cap: 30, tone: 'lyrical' },
  { q: 'Japanese birds and flowers kacho-e print', match: /bird|flower|blossom|crane|heron|owl|carp|butterfl/i, artist: /hiroshige|hokusai|koson|kuniyoshi|utagawa|katsushika/i, cap: 20, tone: 'lyrical' },
  { q: 'Hokusai waterfall wave', match: /waterfall|wave|whirlpool|ocean|sea/i, artist: /hokusai|hiroshige/i, cap: 20, tone: 'lyrical' },
];

/**
 * Second net, on top of series selection: titles signalling a nude or erotic
 * subject. Deliberately broad — over-filtering costs a few cards from a pool
 * of hundreds, while under-filtering puts a nude on a meeting-room screen.
 * Note this catches titles only; the hand review is what actually works.
 */
const UNSAFE_TITLE = new RegExp(
  [
    'nude', 'naked', 'nu\\b', 'undress', 'disrob', 'unclothed',
    'bather', 'bathing', 'bath\\b', 'odalisque', 'harem',
    'venus', 'leda', 'danae', 'danaë', 'susanna', 'bathsheba',
    'adam and eve', 'garden of eden', 'original sin',
    'nymph', 'satyr', 'faun', 'bacchan', 'sappho', 'lesbia',
    'three graces', 'judgment of paris', 'birth of venus',
    'courtesan', 'brothel', 'prostitut', 'harlot', 'seduc', 'erotic',
    'lust', 'lover', 'embrace', 'kiss\\b', 'phallus', 'torso',
    'life study', 'figure study', 'academie', 'académie', 'anatomy',
    'martyrdom', 'flagellat', 'massacre',
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
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) {
        console.warn(`  ! giving up on ${url.slice(0, 80)}…: ${err.message}`);
        return null;
      }
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

/** Portrait or near-square crops read best as cards; skip extreme panoramas. */
function acceptableRatio(w, h) {
  if (!w || !h) return true;
  const r = w / h;
  return r > 0.45 && r < 1.9;
}

let exclusions = new Set();

/** Search one series, following pages until the cap is met or results run out. */
async function collectSeries({ q, match, artist, cap, tone }) {
  const kept = [];
  let screened = 0;

  for (let page = 1; page <= 3 && kept.length < cap; page++) {
    const url =
      'https://api.artic.edu/api/v1/artworks/search?' +
      new URLSearchParams({
        q,
        page: String(page),
        limit: '100',
        fields: 'id,title,image_id,artist_title,date_display,is_public_domain,thumbnail',
      });
    const data = await getJSON(url);
    const rows = data?.data ?? [];
    if (rows.length === 0) break;

    for (const a of rows) {
      if (kept.length >= cap) break;
      if (!a.is_public_domain || !a.image_id || !a.artist_title) continue;
      if (!match.test(a.title ?? '')) continue;
      if (artist && !artist.test(a.artist_title)) continue;
      if (!acceptableRatio(a.thumbnail?.width, a.thumbnail?.height)) continue;
      if (exclusions.has(`aic-${a.id}`)) continue;
      if (UNSAFE_TITLE.test(a.title ?? '')) {
        screened++;
        continue;
      }
      if (kept.some((k) => k.key === `aic-${a.id}`)) continue;

      kept.push({
        key: `aic-${a.id}`,
        url: `https://www.artic.edu/iiif/2/${a.image_id}/full/800,/0/default.jpg`,
        title: a.title,
        artist: a.artist_title,
        date: a.date_display ?? '',
        source: 'Art Institute of Chicago',
        link: `https://www.artic.edu/artworks/${a.id}`,
        series: q,
        tone,
      });
    }
    await sleep(120);
  }

  console.log(
    `  ${String(kept.length).padStart(3)}/${String(cap).padStart(3)}  ${tone.padEnd(8)} ${q}` +
      (screened ? `   (${screened} screened out)` : ''),
  );
  return kept;
}

async function download(card) {
  const file = `${card.key}.jpg`;
  const dest = path.join(OUT_DIR, file);
  if (!FORCE) {
    try {
      const st = await fs.stat(dest);
      if (st.size > 2048) return { ...card, file };
    } catch {
      /* not cached */
    }
  }
  try {
    const res = await fetch(card.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A short body is an HTML error page, not an image.
    if (buf.length < 2048 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
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
        const out = await worker(items[cursor++]);
        if (out) results.push(out);
      }
    }),
  );
  return results;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  exclusions = await loadExclusions();
  if (exclusions.size) console.log(`Honouring ${exclusions.size} manually excluded cards.\n`);

  console.log('Collecting series from the Art Institute of Chicago…');
  const collected = [];
  for (const s of SERIES) collected.push(await collectSeries(s));

  // Round-robin across series so the deck stays varied even if we stop early.
  //
  // De-duplicate on artist + title, not just on id: museums hold several
  // impressions of the same print under different ids, and two visually
  // identical cards on the table would wreck a round.
  const byKey = new Map();
  const seenWork = new Set();
  let dupes = 0;
  const workId = (c) =>
    `${c.artist}|${(c.title ?? '')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')       // drop parenthetical qualifiers
      .replace(/,?\s*(plate|pl\.|no\.)\s*\w+.*$/i, '') // and plate numbering
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()}`;

  for (let i = 0; ; i++) {
    let added = false;
    for (const list of collected) {
      const c = list[i];
      if (!c) continue;
      added = true;
      if (byKey.has(c.key)) continue;
      const w = workId(c);
      if (seenWork.has(w)) {
        dupes++;
        continue;
      }
      seenWork.add(w);
      byKey.set(c.key, c);
    }
    if (!added) break;
  }
  const ordered = [...byKey.values()];
  if (dupes) console.log(`\n  ${dupes} duplicate impressions of the same work dropped.`);

  const strange = ordered.filter((c) => c.tone === 'strange').length;
  console.log(
    `\nFound ${ordered.length} candidates (${strange} strange, ${ordered.length - strange} lyrical). ` +
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
        note: 'Open-access public-domain works as flagged by the holding institution.',
        cards,
      },
      null,
      2,
    ),
  );

  // Drop stale images no longer in the manifest.
  const keep = new Set(cards.map((c) => c.file));
  for (const f of await fs.readdir(OUT_DIR)) {
    if (f.endsWith('.jpg') && !keep.has(f)) await fs.unlink(path.join(OUT_DIR, f));
  }

  const artists = new Set(cards.map((c) => c.artist));
  console.log(`\n✓ Deck ready: ${cards.length} cards from ${artists.size} artists`);
  console.log(`  → ${path.relative(ROOT, OUT_DIR)}/`);
  console.log(
    '\n⚠ This deck has NOT been reviewed. The title filter catches obvious cases,\n' +
      '  but plenty of works have incidental nudity with an innocuous title. Review\n' +
      '  the images and add rejects to scripts/excluded-cards.json before shipping.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
