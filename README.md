# Reverie

### ▶ Play now at **[reverie.walter.com.au](https://reverie.walter.com.au)**

No install, no account — start a game and share the four-letter room code.

---

An open-source clone of **[Dixit](https://www.libellud.com/dixit/)**, the
storytelling card game by Jean-Louis Roubira and Libellud — self-hosted, for
3–15 players, in the browser.

One player is the storyteller: they pick a picture from their hand and give a
clue. Everyone else secretly plays a card that could also fit, then votes on
which was the original. Score by being understood by *some* — but not all.

This is an independent implementation of the game's published rules with its
own public-domain artwork. It is not affiliated with or endorsed by Libellud.
If you enjoy it, [buy the real game](https://www.libellud.com/dixit/) — it is
better, and it comes with Marie Cardouat's illustrations.

- **Rules engine** — `src/rules.js`, pure and fully unit-tested
- **Server** — Node + Express + `ws`, all state in memory
- **Client** — dependency-free ES modules, no build step
- **Deck** — 300 public-domain artworks fetched from museum open-access APIs

## Why this exists

Reverie was built to replace **pixit.fun**, an earlier browser-based Dixit
clone that is no longer online. It was the easiest way to get a group playing
Dixit remotely, and there was nothing quite like it once it went away.

This is a substitute rather than a copy — none of pixit.fun's code or artwork
is used here, and no connection to its authors is claimed or implied. If you
landed here looking for pixit.fun, this is meant to fill the same gap. Thanks
to whoever built it.

The sections below are for running your own instance. To just play, use the
link at the top.

---

## Quick start

```bash
npm install
npm run restore-deck    # downloads the 300 reviewed cards (~90 MB, one-off)
npm start               # http://localhost:8080
```

`restore-deck` fetches exactly the deck recorded in
`public/cards/manifest.json`, which *is* committed. The images themselves are
not, to keep the repository small. **Use `restore-deck`, not `fetch-cards`** —
see [Workplace suitability](#workplace-suitability).

Open the page, enter a name, hit **Start a new game**, and share the 4-letter
room code (or the invite link) with the other players.

Run the tests with `npm test` — 28 tests covering the scoring rules,
large-table games, disconnect handling, and a full game driven over real
WebSockets.

---

## The deck

`npm run fetch-cards` pulls artwork from the
[Art Institute of Chicago](https://api.artic.edu/docs/) and
[The Met](https://metmuseum.github.io/) open-access APIs, keeping only images
each institution has explicitly flagged as public domain. It targets artists
whose work has the dreamlike, symbol-heavy quality the game needs —
Hiroshige, Hokusai, Kuniyoshi, Yoshitoshi, Piranesi, Meryon, Bresdin, Redon,
Doré, Corot and van Gogh among them.

```bash
npm run fetch-cards -- --target 400    # bigger deck
npm run fetch-cards -- --force         # re-download instead of using the cache
```

Attribution for every card is stored in `public/cards/manifest.json` and shown
on the in-app **See the deck** screen.

### Workplace suitability

The deck is built to be safe to put on a screen at work. Three layers:

1. **Artist selection.** The query list is weighted to landscape, architecture,
   nature and narrative illustration. Artists whose corpus is largely figure
   study or erotica are left out entirely rather than filtered afterwards.
2. **Title screening.** `UNSAFE_TITLE` in the fetch script drops anything whose
   title signals a nude or erotic subject. Deliberately broad.
3. **Manual review.** All 300 cards in the shipped deck were inspected
   individually. Rejects are listed with a reason in
   `scripts/excluded-cards.json` and are never re-downloaded.

> **If you re-run `npm run fetch-cards`, the result is no longer a reviewed
> deck.** Museum search results drift, so a re-fetch can pull in images nobody
> has looked at. Review the new cards and add any rejects to
> `scripts/excluded-cards.json`.

Layers 1 and 2 are automatic; layer 3 is the one that actually catches things,
because plenty of works have incidental nudity with an innocuous title.

The images are **not** committed, but the review is not lost either:
`manifest.json` records the exact 300 works and their source URLs, so
`npm run restore-deck` rebuilds the identical reviewed deck from a 128 KB file.

The distinction matters:

| Command | What it does |
| --- | --- |
| `npm run restore-deck` | Re-downloads **the reviewed deck**, exactly. Safe. |
| `npm run fetch-cards` | Searches the museums afresh and builds a **new, unreviewed** selection. Only for deliberately rebuilding the deck. |

The Docker build copies whatever is in `public/cards/`, and the server refuses
to start without a deck — so run `restore-deck` before `fly deploy` on a fresh
checkout.

---

## Deploying to Fly.io

### 1. Install and log in

```bash
brew install flyctl
fly auth signup      # or: fly auth login
```

### 2. Create the app

`fly.toml` is already configured for Sydney (`syd`) with a single always-on
machine — rooms are held in memory, so the app must not auto-stop or scale to
multiple instances.

```bash
fly apps create reverie-walter     # or pick your own name and edit fly.toml
```

### 3. Deploy

```bash
npm run restore-deck             # no-op if the deck is already present
ls public/cards/*.jpg | wc -l    # expect 300 — the reviewed deck
fly deploy --ha=false
fly status                       # MUST show exactly one machine
```

**`--ha=false` is not optional.** A plain `fly deploy` creates a second machine
for high availability. Rooms live in memory, so two machines behind one
hostname means two independent sets of rooms: players who share a code land on
different machines and cannot see each other. If `fly status` ever shows two,
fix it with `fly scale count 1`.

**Use `restore-deck`, never `fetch-cards`, before deploying.** `restore-deck`
rebuilds the reviewed deck exactly; `fetch-cards` searches afresh and produces
a selection nobody has looked at.

Check it works on the Fly-provided hostname before touching DNS:

```bash
fly open                         # https://reverie-walter.fly.dev
fly logs
```

### 4. Point `reverie.walter.com.au` at it

Your DNS is on Cloudflare. Fly needs to prove ownership over plain HTTP to
issue its certificate, so **the record must start as DNS-only (grey cloud)** —
Cloudflare's proxy will otherwise intercept the ACME challenge and the cert
will stay stuck in "Awaiting certificates".

In the Cloudflare dashboard → **walter.com.au** → **DNS** → **Add record**:

| Field | Value |
| --- | --- |
| Type | `CNAME` |
| Name | `reverie` |
| Target | `reverie-walter.fly.dev` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

Then ask Fly for the certificate:

```bash
fly certs add reverie.walter.com.au
fly certs show reverie.walter.com.au     # repeat until it reads "Ready"
```

It usually clears in under a minute. Once it does,
**https://reverie.walter.com.au** is live.

#### Leave it on the grey cloud

It is tempting to switch the record to **Proxied** afterwards for DDoS
protection and image caching. Don't, unless you have a specific reason:

- Fly **renews its certificate over plain HTTP every ~60 days**. Proxied, the
  renewal fails silently and the site breaks roughly two months later — a
  genuinely annoying outage to trace back to a DNS toggle.
- Making it work needs **SSL/TLS → Full (strict)**, which is a **zone-wide**
  setting. If anything else on the domain sits behind the proxy with a
  self-signed or absent origin certificate, changing it breaks *that* site too.

The grey cloud costs you nothing here. Fly already terminates TLS, forces
HTTPS, and serves the card images with a 30-day immutable cache header.

---

## Alternative: run it from your Mac

No hosting bill, but only reachable while your machine is awake.

```bash
brew install cloudflared
npm start                                   # in one terminal
cloudflared tunnel --url http://localhost:8080   # in another
```

That prints a temporary `*.trycloudflare.com` URL. For a permanent
`reverie.walter.com.au` pointing at your Mac, use a named tunnel
(`cloudflared tunnel create reverie`) and add the `CNAME` it gives you —
that record *should* be proxied.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |

Game tuning lives in `src/rules.js` (`HAND_SIZE`, `MIN_PLAYERS`,
`MAX_PLAYERS`, `DEFAULT_TARGET_SCORE`) and `src/room.js`
(`ROOM_CODE_LENGTH`, `EMPTY_ROOM_TTL_MS`, `DISCONNECT_GRACE_MS`).

---

## How the game works

Standard Dixit scoring:

- **Everyone or nobody** guesses the storyteller's card → storyteller scores
  **0**, every other player scores **2**.
- **Otherwise** → the storyteller and each correct guesser score **3**.
- Independently, every non-storyteller scores **1 per vote** their own decoy
  attracted.

First to 30 points wins. In a 3-player game each non-storyteller plays *two*
cards, per the official rules, so there are enough decoys to vote between.

Some deliberate design choices:

- **Reconnects are seamless.** Each player holds a secret token in
  `localStorage`; refreshing the page or locking your phone rejoins the same
  seat with the same hand. Seats are held for 2 minutes after a drop.
- **Hands never leave the server.** Each player receives a state object
  tailored to them — there is a test asserting no other player's cards appear
  in it — and card ownership on the table is withheld until the reveal.
- **Rooms are ephemeral.** They vanish 30 minutes after the last player
  leaves. There is no database and nothing to back up.

---

## Licensing and naming

The source code is MIT (`LICENSE`). The card artwork and the relationship to
Dixit are covered separately in [`NOTICE.md`](NOTICE.md) — in short: the images
are public-domain museum works with attribution in `manifest.json`, and Dixit
is a trademark of Libellud that this project is not affiliated with.

Why the project is set up the way it is — four different rights are in play,
and they carry very different weight:

| | Risk | How it's handled |
| --- | --- | --- |
| **Game mechanics** | None — rules, systems and methods of play aren't copyrightable (17 U.S.C. §102(b)) | Implemented freely |
| **Rulebook wording** | Real — the *expression* of rules is protected even when the rules aren't | All how-to-play text written from scratch |
| **Card artwork** | Real, and the usual reason clones get taken down | Public-domain museum works only |
| **The name** | The genuine exposure — a near-identical mark in the same product category | Renamed; nothing user-facing, and no subdomain, uses the mark |

The practical strategy: the mark appears only in developer-facing docs and
source comments as nominative reference with a disclaimer. It appears nowhere
a search engine or a player would meet it — not in the page title, the meta
description, the UI, or the hostname. Keep it that way, and don't SEO-target
the trademark.

None of this is legal advice.
