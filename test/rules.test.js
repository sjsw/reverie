import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASES,
  HAND_SIZE,
  MAX_PLAYERS,
  createGame,
  addPlayer,
  removePlayer,
  startGame,
  giveClue,
  submitCard,
  castVote,
  scoreRound,
  nextRound,
  storyteller,
  cardsPerPlayer,
  pendingPlayers,
} from '../src/rules.js';

const CARDS = Array.from({ length: 120 }, (_, i) => `c${i}`);

function gameWith(n, seed = 42) {
  const g = createGame({ cards: CARDS, seed });
  for (let i = 0; i < n; i++) addPlayer(g, { id: `p${i}`, name: `Player ${i}` });
  startGame(g);
  return g;
}

/** Play a round where `correctIds` vote for the storyteller's card. */
function playRound(g, correctIds) {
  const st = storyteller(g);
  const others = g.players.filter((p) => p.id !== st.id);

  const stCard = st.hand[0];
  giveClue(g, st.id, { clue: 'a dream of falling', cardId: stCard });

  for (const p of others) {
    for (let i = 0; i < cardsPerPlayer(g); i++) submitCard(g, p.id, p.hand[0]);
  }
  assert.equal(g.phase, PHASES.VOTE);

  for (const p of others) {
    if (correctIds.includes(p.id)) {
      castVote(g, p.id, stCard);
    } else {
      // Vote for any card that is on the table and isn't theirs.
      const decoy = g.table.find(
        (c) => c !== stCard && g.submissions.get(c) !== p.id,
      );
      castVote(g, p.id, decoy);
    }
  }
  return { st, stCard, others };
}

describe('setup', () => {
  test('deals a full hand to each player', () => {
    const g = gameWith(4);
    assert.equal(g.phase, PHASES.CLUE);
    for (const p of g.players) assert.equal(p.hand.length, HAND_SIZE);
  });

  test('refuses to start below the minimum', () => {
    const g = createGame({ cards: CARDS, seed: 1 });
    addPlayer(g, { id: 'a', name: 'A' });
    addPlayer(g, { id: 'b', name: 'B' });
    assert.throws(() => startGame(g), /at least 3/);
  });

  test('three-player games need two cards from each non-storyteller', () => {
    assert.equal(cardsPerPlayer(gameWith(3)), 2);
    assert.equal(cardsPerPlayer(gameWith(4)), 1);
  });

  test('first player is host', () => {
    const g = gameWith(4);
    assert.equal(g.players.filter((p) => p.isHost).length, 1);
  });
});

describe('scoring', () => {
  test('everyone finds it: storyteller 0, others 2', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    playRound(g, others.map((p) => p.id));

    assert.equal(g.lastScoring.outcome, 'all-found');
    assert.equal(st.score, 0);
    for (const p of others) assert.equal(p.score, 2);
  });

  test('nobody finds it: storyteller 0, others 2 plus decoy points', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    playRound(g, []);

    assert.equal(g.lastScoring.outcome, 'none-found');
    assert.equal(st.score, 0);
    // Each voter got 2; decoy votes add 1 each, so the total across the
    // non-storytellers is 2n + (number of votes landing on a decoy).
    const total = others.reduce((s, p) => s + p.score, 0);
    assert.equal(total, others.length * 2 + others.length);
  });

  test('split: storyteller and correct voters get 3', () => {
    const g = gameWith(5);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    const correct = [others[0].id];
    playRound(g, correct);

    assert.equal(g.lastScoring.outcome, 'split');
    assert.equal(st.score, 3);

    // The correct voter scores 3, plus 1 for every vote their own decoy drew.
    const decoyVotes = Object.values(g.lastScoring.breakdown)
      .filter((b) => b.ownerId === correct[0])
      .reduce((n, b) => n + b.voterIds.length, 0);
    assert.equal(g.players.find((p) => p.id === correct[0]).score, 3 + decoyVotes);
  });

  test('a decoy earns its owner one point per vote it attracts', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);

    const stCard = st.hand[0];
    giveClue(g, st.id, { clue: 'moonlit', cardId: stCard });
    const decoys = others.map((p) => {
      const card = p.hand[0];
      submitCard(g, p.id, card);
      return { pid: p.id, card };
    });

    // Everyone piles onto the first player's decoy; its owner votes correctly.
    const target = decoys[0];
    castVote(g, decoys[0].pid, stCard);
    castVote(g, decoys[1].pid, target.card);
    castVote(g, decoys[2].pid, target.card);

    assert.equal(g.phase, PHASES.REVEAL);
    // Split outcome: storyteller 3, the correct voter 3, +2 decoy votes.
    assert.equal(st.score, 3);
    assert.equal(g.players.find((p) => p.id === target.pid).score, 3 + 2);
  });

  test('you cannot vote for your own card', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    giveClue(g, st.id, { clue: 'x', cardId: st.hand[0] });
    const own = others[0].hand[0];
    for (const p of others) submitCard(g, p.id, p.hand[0]);
    assert.throws(() => castVote(g, others[0].id, own), /your own card/);
  });

  test('the storyteller does not vote', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    giveClue(g, st.id, { clue: 'x', cardId: st.hand[0] });
    for (const p of others) submitCard(g, p.id, p.hand[0]);
    assert.throws(() => castVote(g, st.id, g.table[0]), /does not vote/);
  });
});

describe('round flow', () => {
  test('storyteller rotates and hands refill', () => {
    const g = gameWith(4);
    const first = storyteller(g).id;
    playRound(g, []);
    nextRound(g);

    assert.equal(g.phase, PHASES.CLUE);
    assert.equal(g.round, 2);
    assert.notEqual(storyteller(g).id, first);
    for (const p of g.players) assert.equal(p.hand.length, HAND_SIZE);
  });

  test('game ends when a player reaches the target score', () => {
    const g = gameWith(4);
    g.targetScore = 2;
    playRound(g, g.players.filter((p) => p.id !== storyteller(g).id).map((p) => p.id));
    nextRound(g);
    assert.equal(g.phase, PHASES.FINISHED);
    assert.equal(g.winners.length, 3); // the three voters all hit 2
  });

  test('phase gates reject out-of-order actions', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    const other = g.players.find((p) => p.id !== st.id);
    assert.throws(() => submitCard(g, other.id, other.hand[0]), /submissions/);
    assert.throws(() => castVote(g, other.id, 'c0'), /votes/);
    assert.throws(() => giveClue(g, other.id, { clue: 'x', cardId: other.hand[0] }), /storyteller/);
    assert.throws(() => giveClue(g, st.id, { clue: '  ', cardId: st.hand[0] }), /empty/);
  });

  test('pendingPlayers reports who we are waiting on', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    assert.deepEqual(pendingPlayers(g), [st.id]);

    giveClue(g, st.id, { clue: 'x', cardId: st.hand[0] });
    assert.equal(pendingPlayers(g).length, 3);

    const others = g.players.filter((p) => p.id !== st.id);
    submitCard(g, others[0].id, others[0].hand[0]);
    assert.equal(pendingPlayers(g).length, 2);
  });
});

describe('disconnects', () => {
  test('a leaving player unblocks a stuck vote', () => {
    const g = gameWith(5);
    const st = storyteller(g);
    const others = g.players.filter((p) => p.id !== st.id);
    giveClue(g, st.id, { clue: 'x', cardId: st.hand[0] });
    for (const p of others) submitCard(g, p.id, p.hand[0]);

    castVote(g, others[0].id, g.table.find((c) => g.submissions.get(c) !== others[0].id));
    castVote(g, others[1].id, g.table.find((c) => g.submissions.get(c) !== others[1].id));
    castVote(g, others[2].id, g.table.find((c) => g.submissions.get(c) !== others[2].id));
    assert.equal(g.phase, PHASES.VOTE);

    removePlayer(g, others[3].id); // the last voter walks out
    assert.equal(g.phase, PHASES.REVEAL);
  });

  test('the storyteller leaving voids the round', () => {
    const g = gameWith(4);
    const st = storyteller(g);
    giveClue(g, st.id, { clue: 'x', cardId: st.hand[0] });
    removePlayer(g, st.id);
    assert.equal(g.phase, PHASES.CLUE);
    assert.equal(g.submissions.size, 0);
  });

  test('dropping below the minimum returns everyone to the lobby', () => {
    const g = gameWith(3);
    removePlayer(g, g.players[0].id);
    assert.equal(g.phase, PHASES.LOBBY);
  });

  test('host passes to the next player', () => {
    const g = gameWith(4);
    const host = g.players.find((p) => p.isHost);
    removePlayer(g, host.id);
    assert.equal(g.players.filter((p) => p.isHost).length, 1);
  });
});

describe('large games', () => {
  test('a full round works at the maximum player count', () => {
    const g = gameWith(MAX_PLAYERS);
    assert.equal(g.players.length, 15);
    for (const p of g.players) assert.equal(p.hand.length, HAND_SIZE);

    const { st, others } = playRound(g, []);
    // One card from the storyteller plus one from everyone else.
    assert.equal(g.table.length, MAX_PLAYERS);
    assert.equal(others.length, MAX_PLAYERS - 1);
    assert.equal(g.phase, PHASES.REVEAL);
    assert.equal(st.score, 0); // nobody found it
    nextRound(g);
    for (const p of g.players) assert.equal(p.hand.length, HAND_SIZE);
  });

  test('refuses a sixteenth player', () => {
    const g = createGame({ cards: CARDS, seed: 3 });
    for (let i = 0; i < MAX_PLAYERS; i++) addPlayer(g, { id: `p${i}`, name: `P${i}` });
    assert.throws(() => addPlayer(g, { id: 'extra', name: 'Extra' }), /full/i);
  });

  test('the deck can seat a full table', () => {
    // The server enforces this too, but the arithmetic is worth pinning down.
    assert.ok(HAND_SIZE * MAX_PLAYERS <= 300, 'a 300-card deck must seat everyone');
  });
});

describe('deck', () => {
  test('recycles the discard pile rather than running dry', () => {
    const g = createGame({ cards: CARDS.slice(0, 30), seed: 7 });
    for (let i = 0; i < 4; i++) addPlayer(g, { id: `p${i}`, name: `P${i}` });
    startGame(g);
    for (let r = 0; r < 12 && g.phase !== PHASES.FINISHED; r++) {
      playRound(g, []);
      nextRound(g);
    }
    for (const p of g.players) {
      if (g.phase !== PHASES.FINISHED) assert.equal(p.hand.length, HAND_SIZE);
    }
  });
});
