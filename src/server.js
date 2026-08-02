/**
 * HTTP + WebSocket server for Reverie.
 *
 * Static files come from public/, the game protocol runs over a single
 * WebSocket at /ws. Everything is in-memory: rooms are ephemeral by design,
 * which keeps deployment to a single stateless-ish container.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import * as R from './rules.js';
import { RoomStore, ROOM_CODE_LENGTH } from './room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/* ---------------------------------------------------------------- deck --- */

function loadDeck() {
  const manifestPath = path.join(PUBLIC_DIR, 'cards', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(
      '\nNo card deck found. Run `npm run fetch-cards` before starting the server.\n',
    );
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cards = manifest.cards.filter((c) =>
    fs.existsSync(path.join(PUBLIC_DIR, 'cards', c.file)),
  );
  if (cards.length < R.HAND_SIZE * R.MAX_PLAYERS) {
    console.error(`Deck too small (${cards.length} cards). Re-run \`npm run fetch-cards\`.`);
    process.exit(1);
  }
  return { manifest, cards };
}

const { manifest, cards } = loadDeck();
const cardIds = cards.map((c) => c.file.replace(/\.jpg$/, ''));
const cardMeta = Object.fromEntries(
  cards.map((c) => [
    c.file.replace(/\.jpg$/, ''),
    { file: c.file, title: c.title, artist: c.artist, date: c.date, source: c.source, link: c.link },
  ]),
);

const store = new RoomStore(cardIds);
console.log(`Deck loaded: ${cardIds.length} cards`);

/* ---------------------------------------------------------------- http --- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

// Card images are immutable and content-addressed by museum id — cache hard.
app.use(
  '/cards',
  express.static(path.join(PUBLIC_DIR, 'cards'), {
    maxAge: '30d',
    immutable: true,
    fallthrough: false,
  }),
);
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

app.get('/healthz', (_req, res) => res.json({ ok: true, ...store.stats }));

app.get('/api/cards', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ count: cardIds.length, generated: manifest.generated, cards: cardMeta });
});

app.post('/api/rooms', (req, res) => {
  const raw = Number(req.body?.targetScore);
  const targetScore = Number.isFinite(raw) ? Math.min(60, Math.max(5, Math.round(raw))) : undefined;
  const room = store.create({ targetScore });
  res.json({ code: room.code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    phase: room.game.phase,
    players: room.game.players.length,
    maxPlayers: R.MAX_PLAYERS,
    canJoin: room.game.phase === R.PHASES.LOBBY && room.game.players.length < R.MAX_PLAYERS,
  });
});

// Room links like /ABCD should serve the app shell.
app.get(
  new RegExp(`^/[A-Z0-9]{${ROOM_CODE_LENGTH}}$`),
  (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')),
);

const server = http.createServer(app);

/* ----------------------------------------------------------- websocket --- */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

/** Simple per-connection flood guard. */
function rateLimited(ctx) {
  const now = Date.now();
  if (now - ctx.windowStart > 1000) {
    ctx.windowStart = now;
    ctx.count = 0;
  }
  return ++ctx.count > 30;
}

wss.on('connection', (ws) => {
  const ctx = { room: null, playerId: null, windowStart: Date.now(), count: 0 };

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const fail = (message) => ws.send(JSON.stringify({ type: 'error', message }));

  ws.on('message', (raw) => {
    if (rateLimited(ctx)) return fail('Slow down.');

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail('Malformed message');
    }

    try {
      handle(ws, ctx, msg, fail);
    } catch (err) {
      fail(err.message || 'Something went wrong');
    }
  });

  ws.on('close', () => {
    if (ctx.room && ctx.playerId) {
      ctx.room.disconnect(ctx.playerId);
      ctx.room.broadcast();
    }
  });
});

function handle(ws, ctx, msg, fail) {
  const { type } = msg;

  if (type === 'join') {
    const room = store.get(msg.code);
    if (!room) return fail('Room not found — check the code.');

    let result;
    try {
      result = room.join({ token: msg.token, name: msg.name });
    } catch (err) {
      return fail(err.message);
    }

    // A second tab for the same seat: retire the older socket.
    const existing = room.sockets.get(result.player.id);
    if (existing && existing !== ws) {
      room.send(existing, { type: 'error', message: 'Opened in another window.' });
      existing.close();
    }

    ctx.room = room;
    ctx.playerId = result.player.id;
    room.sockets.set(result.player.id, ws);
    room.touch();

    room.send(ws, {
      type: 'joined',
      token: result.token,
      playerId: result.player.id,
      code: room.code,
    });
    if (!result.rejoined) room.addLogEntry(`${result.player.name} joined`);
    return room.broadcast();
  }

  const { room, playerId } = ctx;
  if (!room || !playerId) return fail('Join a room first');
  room.touch();

  switch (type) {
    case 'start': {
      if (!room.isHost(playerId)) return fail('Only the host can start the game');
      R.startGame(room.game);
      room.addLogEntry('Game started');
      break;
    }

    case 'clue': {
      R.giveClue(room.game, playerId, { clue: msg.clue, cardId: msg.cardId });
      break;
    }

    case 'submit': {
      R.submitCard(room.game, playerId, msg.cardId);
      break;
    }

    case 'vote': {
      R.castVote(room.game, playerId, msg.cardId);
      break;
    }

    case 'next': {
      if (!room.isHost(playerId)) return fail('Only the host can advance the round');
      const finishing = room.game.lastScoring;
      R.nextRound(room.game);
      if (finishing) room.addLogEntry(`Round ${finishing.clue ? `“${finishing.clue}”` : ''} scored`);
      break;
    }

    case 'playAgain': {
      if (!room.isHost(playerId)) return fail('Only the host can restart');
      R.resetToLobby(room.game);
      room.addLogEntry('Back to the lobby');
      break;
    }

    case 'leave': {
      room.removeCompletely(playerId);
      ctx.room = null;
      ctx.playerId = null;
      room.broadcast();
      return;
    }

    case 'ping':
      return room.send(ws, { type: 'pong' });

    default:
      return fail(`Unknown action: ${type}`);
  }

  room.broadcast();
}

// Drop sockets that stop answering pings (mobile browsers rarely close cleanly).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`Reverie listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    for (const ws of wss.clients) ws.close(1001, 'Server restarting');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
