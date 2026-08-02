/**
 * Room lifecycle: wraps the pure rules engine with identity, presence and
 * per-player state serialisation.
 *
 * A player is identified by a secret `token` held in the browser's
 * localStorage, so a refresh or a dropped connection rejoins the same seat
 * instead of creating a ghost.
 */

import crypto from 'node:crypto';
import * as R from './rules.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const ROOM_CODE_LENGTH = 4; // short enough to read aloud; ~1M combinations
const EMPTY_ROOM_TTL_MS = 1000 * 60 * 30; // reap 30 min after the last player leaves
const DISCONNECT_GRACE_MS = 1000 * 60 * 2; // seat is held this long after a drop

export class RoomStore {
  constructor(cards) {
    this.cards = cards;
    this.rooms = new Map(); // code -> Room
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref?.();
  }

  newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = Array.from(
        crypto.randomBytes(ROOM_CODE_LENGTH),
        (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length],
      ).join('');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code');
  }

  create({ targetScore } = {}) {
    const code = this.newCode();
    const room = new Room(code, this.cards, { targetScore });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim()) ?? null;
  }

  reap() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      room.expireGrace(now);
      const active = room.game.players.some((p) => p.connected);
      if (!active && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(code);
      }
    }
  }

  get stats() {
    return {
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((n, r) => n + r.game.players.length, 0),
    };
  }
}

export class Room {
  constructor(code, cards, { targetScore } = {}) {
    this.code = code;
    this.game = R.createGame({ cards, targetScore });
    this.tokens = new Map(); // token -> playerId
    this.sockets = new Map(); // playerId -> ws
    this.droppedAt = new Map(); // playerId -> timestamp
    this.lastActivity = Date.now();
    this.log = []; // recent round summaries, for the activity feed
  }

  touch() {
    this.lastActivity = Date.now();
  }

  /** Join as a new player, or reclaim an existing seat with a known token. */
  join({ token, name }) {
    this.touch();
    const clean = String(name ?? '').trim().slice(0, 20) || 'Anonymous';

    if (token && this.tokens.has(token)) {
      const playerId = this.tokens.get(token);
      const player = this.game.players.find((p) => p.id === playerId);
      if (player) {
        player.connected = true;
        player.name = clean;
        this.droppedAt.delete(playerId);
        return { token, player, rejoined: true };
      }
    }

    const newToken = crypto.randomUUID();
    const player = R.addPlayer(this.game, { id: crypto.randomUUID(), name: clean });
    this.tokens.set(newToken, player.id);
    return { token: newToken, player, rejoined: false };
  }

  playerFor(token) {
    const id = this.tokens.get(token);
    return id ? this.game.players.find((p) => p.id === id) ?? null : null;
  }

  /**
   * Mark a socket as gone. The seat is held for a grace period so a phone
   * locking its screen mid-game doesn't wipe someone's hand and score.
   */
  disconnect(playerId) {
    const player = this.game.players.find((p) => p.id === playerId);
    if (!player) return;
    player.connected = false;
    this.sockets.delete(playerId);

    if (this.game.phase === R.PHASES.LOBBY) {
      this.removeCompletely(playerId);
    } else {
      this.droppedAt.set(playerId, Date.now());
    }
    this.touch();
  }

  /** Drop seats whose grace period has elapsed. */
  expireGrace(now = Date.now()) {
    let changed = false;
    for (const [playerId, at] of [...this.droppedAt]) {
      if (now - at > DISCONNECT_GRACE_MS) {
        this.removeCompletely(playerId);
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  removeCompletely(playerId) {
    R.removePlayer(this.game, playerId);
    this.droppedAt.delete(playerId);
    this.sockets.delete(playerId);
    for (const [t, id] of [...this.tokens]) if (id === playerId) this.tokens.delete(t);
  }

  isHost(playerId) {
    return this.game.players.find((p) => p.id === playerId)?.isHost === true;
  }

  addLogEntry(text) {
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 30) this.log.shift();
  }

  /**
   * Build the view of the game for one player. Never leaks other players'
   * hands, and hides card ownership until the reveal.
   */
  stateFor(playerId) {
    const g = this.game;
    const me = g.players.find((p) => p.id === playerId) ?? null;
    const st = R.storyteller(g);
    const revealing = g.phase === R.PHASES.REVEAL || g.phase === R.PHASES.FINISHED;
    const pending = new Set(R.pendingPlayers(g));

    const mySubmissions = [...g.submissions]
      .filter(([, pid]) => pid === playerId)
      .map(([cardId]) => cardId);

    return {
      code: this.code,
      phase: g.phase,
      round: g.round,
      targetScore: g.targetScore,
      clue: g.clue,
      cardsPerPlayer: R.cardsPerPlayer(g),
      deckRemaining: g.deck.length,
      minPlayers: R.MIN_PLAYERS,
      maxPlayers: R.MAX_PLAYERS,
      storytellerId: st?.id ?? null,
      you: me
        ? {
            id: me.id,
            name: me.name,
            score: me.score,
            hand: me.hand,
            isHost: me.isHost,
            isStoryteller: st?.id === me.id,
            submitted: mySubmissions,
            votedFor: g.votes.get(me.id) ?? null,
          }
        : null,
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isHost: p.isHost,
        handCount: p.hand.length,
        waitingOn: pending.has(p.id),
      })),
      // During voting the table is anonymous; ownership appears at the reveal.
      table: g.table.map((cardId) => ({
        cardId,
        owner: revealing ? g.submissions.get(cardId) : null,
        voters: revealing
          ? [...g.votes].filter(([, c]) => c === cardId).map(([v]) => v)
          : [],
        isStorytellerCard: revealing ? g.lastScoring?.storytellerCard === cardId : false,
      })),
      scoring: revealing ? g.lastScoring : null,
      winners: g.winners,
      log: this.log.slice(-8),
    };
  }

  send(ws, message) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Push fresh, individually-tailored state to every connected player. */
  broadcast() {
    for (const [playerId, ws] of this.sockets) {
      this.send(ws, { type: 'state', state: this.stateFor(playerId) });
    }
  }
}
