/**
 * Counters on /healthz.
 *
 * `rooms` and `players` are gauges — they describe this instant, so a poller
 * misses any game that begins and ends between two samples. The cumulative
 * counters exist so that sampling cannot undercount, and these tests are
 * mostly about the transitions that a naive implementation would miss.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RoomStore } from '../src/room.js';
import * as R from '../src/rules.js';

const CARDS = Array.from({ length: 200 }, (_, i) => `card-${i}`);

const newStore = () => new RoomStore(CARDS);

/** Seat `n` players in a fresh room and start the game. */
function startedRoom(store, n = 4) {
  const room = store.create();
  for (let i = 0; i < n; i++) room.join({ name: `P${i}` });
  R.startGame(room.game);
  room.broadcast();
  return room;
}

/** Drive a started room all the way to a winner. */
function playUntilFinished(room, limit = 200) {
  for (let guard = 0; guard < limit; guard++) {
    const g = room.game;
    if (g.phase === R.PHASES.FINISHED) return true;

    if (g.phase === R.PHASES.CLUE) {
      const st = R.storyteller(g);
      R.giveClue(g, st.id, { clue: 'a clue', cardId: st.hand[0] });
    } else if (g.phase === R.PHASES.SUBMIT) {
      const st = R.storyteller(g);
      for (const p of g.players) {
        if (p.id === st.id) continue;
        for (const cardId of R.pendingPlayers(g).includes(p.id) ? [p.hand[0]] : []) {
          R.submitCard(g, p.id, cardId);
        }
      }
    } else if (g.phase === R.PHASES.VOTE) {
      const st = R.storyteller(g);
      for (const p of g.players) {
        if (p.id === st.id) continue;
        if (g.votes.has(p.id)) continue;
        const choice = g.table.find((c) => g.submissions.get(c) !== p.id);
        R.castVote(g, p.id, choice);
      }
    } else if (g.phase === R.PHASES.REVEAL) {
      R.nextRound(g);
    }
    room.broadcast();
  }
  return room.game.phase === R.PHASES.FINISHED;
}

describe('stats', () => {
  test('starts at zero and reports when it started', () => {
    const stats = newStore().stats;
    assert.equal(stats.rooms, 0);
    assert.equal(stats.players, 0);
    assert.equal(stats.roomsCreated, 0);
    assert.equal(stats.gamesStarted, 0);
    assert.equal(stats.gamesFinished, 0);
    assert.match(stats.since, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Number.isInteger(stats.uptimeSeconds));
  });

  test('counts rooms as they are opened', () => {
    const store = newStore();
    store.create();
    store.create();
    assert.equal(store.stats.roomsCreated, 2);
    assert.equal(store.stats.rooms, 2);
  });

  test('a created room that never starts is not a started game', () => {
    const store = newStore();
    const room = store.create();
    room.join({ name: 'Alone' });
    room.broadcast();
    assert.equal(store.stats.roomsCreated, 1);
    assert.equal(store.stats.gamesStarted, 0);
  });

  test('counts a game once when it starts, not once per broadcast', () => {
    const store = newStore();
    const room = startedRoom(store);
    room.broadcast();
    room.broadcast();
    assert.equal(store.stats.gamesStarted, 1);
  });

  test('counts a finished game once, however long it sits finished', () => {
    const store = newStore();
    const room = startedRoom(store);
    assert.ok(playUntilFinished(room), 'game should reach a winner');

    assert.equal(store.stats.gamesFinished, 1);
    room.broadcast();
    room.broadcast();
    assert.equal(store.stats.gamesFinished, 1);
  });

  test('playing again counts as a second game', () => {
    const store = newStore();
    const room = startedRoom(store);
    playUntilFinished(room);

    R.resetToLobby(room.game);
    room.broadcast();
    R.startGame(room.game);
    room.broadcast();

    assert.equal(store.stats.gamesStarted, 2);
    assert.equal(store.stats.gamesFinished, 1);
    assert.equal(store.stats.roomsCreated, 1); // same room throughout
  });

  test('counters survive the room being reaped', () => {
    // The gauges go back to zero when a room is cleaned up; the totals must
    // not, or a poller that samples afterwards sees no evidence of the game.
    const store = newStore();
    const room = startedRoom(store);
    playUntilFinished(room);

    store.rooms.delete(room.code);
    const stats = store.stats;
    assert.equal(stats.rooms, 0);
    assert.equal(stats.players, 0);
    assert.equal(stats.gamesStarted, 1);
    assert.equal(stats.gamesFinished, 1);
    assert.equal(stats.roomsCreated, 1);
  });

  test('remembers the busiest moment after everyone leaves', () => {
    const store = newStore();
    const room = startedRoom(store, 5);
    assert.equal(store.stats.peakPlayers, 5);
    assert.equal(store.stats.peakRooms, 1);

    for (const p of [...room.game.players]) room.removeCompletely(p.id);
    room.broadcast();

    assert.equal(store.stats.players, 0);
    assert.equal(store.stats.peakPlayers, 5, 'peak must not fall back');
  });

  test('a game that ends without an explicit action is still counted', () => {
    // The transition into FINISHED can happen inside castVote or even a
    // disconnect, not only on the host pressing "next". Hooking the count to
    // broadcast rather than to the action handlers is what makes this work, so
    // it is pinned down here: drive the phase directly and never call an
    // action-shaped helper.
    const store = newStore();
    const room = startedRoom(store);

    room.game.phase = R.PHASES.FINISHED;
    room.broadcast();

    assert.equal(store.stats.gamesFinished, 1);
  });
});
