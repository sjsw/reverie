/**
 * Pure Dixit rules engine.
 *
 * No I/O, no timers, no sockets — every function takes a game object and
 * returns either a new phase or a mutation, so the whole ruleset is testable
 * in isolation. `src/room.js` wraps this with networking concerns.
 *
 * Phases: lobby -> clue -> submit -> vote -> reveal -> (clue | finished)
 */

export const HAND_SIZE = 6;
export const MIN_PLAYERS = 3;
/**
 * Well above Dixit's official 6 (12 with expansions). The rules scale, but the
 * feel changes: with 14 decoys on the table almost nobody finds the
 * storyteller's card by luck, so the "everyone guessed" penalty effectively
 * stops firing and rounds take much longer. Fine for a big party, worse as a
 * game. See the deck-size assertion in src/server.js — HAND_SIZE * MAX_PLAYERS
 * cards must exist before anyone can play.
 */
export const MAX_PLAYERS = 15;
export const DEFAULT_TARGET_SCORE = 30;

export const PHASES = {
  LOBBY: 'lobby',
  CLUE: 'clue',
  SUBMIT: 'submit',
  VOTE: 'vote',
  REVEAL: 'reveal',
  FINISHED: 'finished',
};

/** Mulberry32 — small seedable PRNG so games are reproducible in tests. */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, in place. */
export function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function createGame({ cards, seed, targetScore = DEFAULT_TARGET_SCORE }) {
  return {
    phase: PHASES.LOBBY,
    players: [], // { id, name, score, hand: [], connected, isHost }
    deck: [],
    discard: [],
    allCards: [...cards],
    rng: makeRng(seed),
    targetScore,
    round: 0,
    storytellerIndex: 0,
    clue: null,
    /** cardId -> playerId. Insertion order is NOT display order (see `table`). */
    submissions: new Map(),
    /** playerId -> cardId */
    votes: new Map(),
    /** Shuffled cardIds revealed during vote/reveal. */
    table: [],
    lastScoring: null,
    winners: [],
  };
}

export function addPlayer(game, { id, name }) {
  if (game.players.length >= MAX_PLAYERS) {
    throw new Error(`Room is full (max ${MAX_PLAYERS} players)`);
  }
  if (game.phase !== PHASES.LOBBY) {
    throw new Error('Game already in progress');
  }
  const player = {
    id,
    name,
    score: 0,
    hand: [],
    connected: true,
    isHost: game.players.length === 0,
  };
  game.players.push(player);
  return player;
}

/**
 * Remove a player entirely. Mid-round this can be the thing that unblocks a
 * phase (everyone left was waiting on them), so we re-check the gates after.
 */
export function removePlayer(game, playerId) {
  const idx = game.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const wasStoryteller = storyteller(game)?.id === playerId;
  const [gone] = game.players.splice(idx, 1);

  // Return their cards so the deck doesn't bleed out.
  game.discard.push(...gone.hand);
  for (const [cardId, pid] of [...game.submissions]) {
    if (pid === playerId) {
      game.submissions.delete(cardId);
      game.discard.push(cardId);
    }
  }
  game.votes.delete(playerId);
  // Votes cast *for* a card that no longer exists have to go too.
  for (const [voterId, cardId] of [...game.votes]) {
    if (!game.submissions.has(cardId)) game.votes.delete(voterId);
  }
  game.table = game.table.filter((c) => game.submissions.has(c));

  if (gone.isHost && game.players.length > 0) {
    game.players[0].isHost = true;
  }
  // Keep the storyteller pointer in range and pointing at the same player
  // where possible.
  if (idx < game.storytellerIndex) game.storytellerIndex--;
  if (game.storytellerIndex >= game.players.length) game.storytellerIndex = 0;

  if (game.phase === PHASES.LOBBY || game.phase === PHASES.FINISHED) return;

  // Too few players left to continue a real game.
  if (game.players.length < MIN_PLAYERS) {
    resetToLobby(game);
    return;
  }
  // The storyteller walking out mid-round voids the round.
  if (wasStoryteller && game.phase !== PHASES.REVEAL) {
    abortRound(game);
    return;
  }
  if (game.phase === PHASES.SUBMIT && allSubmitted(game)) beginVotePhase(game);
  else if (game.phase === PHASES.VOTE && allVoted(game)) scoreRound(game);
}

/** Throw the current round away and re-deal, without scoring it. */
export function abortRound(game) {
  game.discard.push(...game.submissions.keys());
  refillHands(game);
  beginCluePhase(game);
}

export function storyteller(game) {
  return game.players[game.storytellerIndex] ?? null;
}

/**
 * How many cards each non-storyteller contributes. Official Dixit uses two
 * cards per player in a 3-player game so there are enough decoys to make
 * voting meaningful.
 */
export function cardsPerPlayer(game) {
  return game.players.length === 3 ? 2 : 1;
}

function drawCard(game) {
  if (game.deck.length === 0) {
    if (game.discard.length === 0) return null;
    game.deck = shuffle([...game.discard], game.rng);
    game.discard = [];
  }
  return game.deck.pop();
}

export function refillHands(game) {
  for (const p of game.players) {
    while (p.hand.length < HAND_SIZE) {
      const card = drawCard(game);
      if (card == null) return false; // deck exhausted
      p.hand.push(card);
    }
  }
  return true;
}

export function startGame(game) {
  if (game.players.length < MIN_PLAYERS) {
    throw new Error(`Need at least ${MIN_PLAYERS} players to start`);
  }
  game.deck = shuffle([...game.allCards], game.rng);
  game.discard = [];
  for (const p of game.players) {
    p.score = 0;
    p.hand = [];
  }
  shuffle(game.players, game.rng);
  game.players.forEach((p, i) => {
    p.isHost = p.isHost || false;
    void i;
  });
  refillHands(game);
  game.round = 1;
  game.storytellerIndex = 0;
  beginCluePhase(game);
}

function beginCluePhase(game) {
  game.phase = PHASES.CLUE;
  game.clue = null;
  game.submissions = new Map();
  game.votes = new Map();
  game.table = [];
  game.lastScoring = null;
}

export function giveClue(game, playerId, { clue, cardId }) {
  if (game.phase !== PHASES.CLUE) throw new Error('Not accepting a clue right now');
  const st = storyteller(game);
  if (!st || st.id !== playerId) throw new Error('Only the storyteller can give the clue');
  const text = String(clue ?? '').trim();
  if (!text) throw new Error('Clue cannot be empty');
  if (text.length > 120) throw new Error('Clue is too long (120 characters max)');
  if (!st.hand.includes(cardId)) throw new Error('That card is not in your hand');

  game.clue = text;
  st.hand.splice(st.hand.indexOf(cardId), 1);
  game.submissions.set(cardId, playerId);
  game.phase = PHASES.SUBMIT;
}

export function submitCard(game, playerId, cardId) {
  if (game.phase !== PHASES.SUBMIT) throw new Error('Not accepting submissions right now');
  const player = game.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Unknown player');
  if (storyteller(game)?.id === playerId) throw new Error('The storyteller has already played');
  if (!player.hand.includes(cardId)) throw new Error('That card is not in your hand');

  const already = [...game.submissions].filter(([, pid]) => pid === playerId).length;
  if (already >= cardsPerPlayer(game)) throw new Error('You have already submitted');

  player.hand.splice(player.hand.indexOf(cardId), 1);
  game.submissions.set(cardId, playerId);

  if (allSubmitted(game)) beginVotePhase(game);
}

export function allSubmitted(game) {
  const expected = 1 + (game.players.length - 1) * cardsPerPlayer(game);
  return game.submissions.size >= expected;
}

function beginVotePhase(game) {
  game.table = shuffle([...game.submissions.keys()], game.rng);
  game.phase = PHASES.VOTE;
}

export function castVote(game, playerId, cardId) {
  if (game.phase !== PHASES.VOTE) throw new Error('Not accepting votes right now');
  if (storyteller(game)?.id === playerId) throw new Error('The storyteller does not vote');
  if (!game.players.some((p) => p.id === playerId)) throw new Error('Unknown player');
  if (!game.table.includes(cardId)) throw new Error('That card is not on the table');
  if (game.submissions.get(cardId) === playerId) throw new Error('You cannot vote for your own card');

  game.votes.set(playerId, cardId);
  if (allVoted(game)) scoreRound(game);
}

export function allVoted(game) {
  return game.votes.size >= game.players.length - 1;
}

/**
 * Dixit scoring:
 *  - If every voter or no voter found the storyteller's card, the storyteller
 *    scores 0 and everyone else scores 2.
 *  - Otherwise the storyteller and each correct voter score 3.
 *  - Either way, non-storytellers score 1 per vote their own decoy attracted.
 */
export function scoreRound(game) {
  const st = storyteller(game);
  const storytellerCard = [...game.submissions].find(([, pid]) => pid === st.id)?.[0];
  const voters = game.players.filter((p) => p.id !== st.id);
  const correct = voters.filter((p) => game.votes.get(p.id) === storytellerCard);

  const delta = new Map(game.players.map((p) => [p.id, 0]));
  const everyone = correct.length === voters.length;
  const nobody = correct.length === 0;

  if (everyone || nobody) {
    for (const v of voters) delta.set(v.id, delta.get(v.id) + 2);
  } else {
    delta.set(st.id, delta.get(st.id) + 3);
    for (const v of correct) delta.set(v.id, delta.get(v.id) + 3);
  }

  for (const [voterId, cardId] of game.votes) {
    const owner = game.submissions.get(cardId);
    if (owner && owner !== st.id && owner !== voterId) {
      delta.set(owner, delta.get(owner) + 1);
    }
  }

  for (const p of game.players) p.score += delta.get(p.id) ?? 0;

  game.lastScoring = {
    storytellerId: st.id,
    storytellerCard,
    clue: game.clue,
    outcome: everyone ? 'all-found' : nobody ? 'none-found' : 'split',
    delta: Object.fromEntries(delta),
    // cardId -> { ownerId, voterIds }
    breakdown: Object.fromEntries(
      game.table.map((cardId) => [
        cardId,
        {
          ownerId: game.submissions.get(cardId),
          voterIds: [...game.votes].filter(([, c]) => c === cardId).map(([v]) => v),
        },
      ]),
    ),
  };

  game.phase = PHASES.REVEAL;
}

/** Advance to the next round, or end the game. Called after the reveal. */
export function nextRound(game) {
  if (game.phase !== PHASES.REVEAL) throw new Error('Round is not over yet');

  game.discard.push(...game.submissions.keys());
  const dealt = refillHands(game);

  const reachedTarget = game.players.some((p) => p.score >= game.targetScore);
  if (reachedTarget || !dealt) {
    const best = Math.max(...game.players.map((p) => p.score));
    game.winners = game.players.filter((p) => p.score === best).map((p) => p.id);
    game.phase = PHASES.FINISHED;
    return;
  }

  game.storytellerIndex = (game.storytellerIndex + 1) % game.players.length;
  game.round++;
  beginCluePhase(game);
}

/** Reset back to the lobby, keeping the same players, so they can replay. */
export function resetToLobby(game) {
  game.phase = PHASES.LOBBY;
  game.round = 0;
  game.storytellerIndex = 0;
  game.winners = [];
  game.lastScoring = null;
  game.clue = null;
  game.submissions = new Map();
  game.votes = new Map();
  game.table = [];
  for (const p of game.players) {
    p.score = 0;
    p.hand = [];
  }
}

/** Who the game is still waiting on, for the "waiting for…" UI. */
export function pendingPlayers(game) {
  const st = storyteller(game);
  if (game.phase === PHASES.CLUE) return st ? [st.id] : [];
  if (game.phase === PHASES.SUBMIT) {
    const per = cardsPerPlayer(game);
    return game.players
      .filter((p) => p.id !== st?.id)
      .filter(
        (p) => [...game.submissions].filter(([, pid]) => pid === p.id).length < per,
      )
      .map((p) => p.id);
  }
  if (game.phase === PHASES.VOTE) {
    return game.players.filter((p) => p.id !== st?.id && !game.votes.has(p.id)).map((p) => p.id);
  }
  return [];
}
