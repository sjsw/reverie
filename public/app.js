/**
 * Reverie client.
 *
 * The server owns all game state; this file renders whatever `state` message
 * arrives and sends intents back. No local rules logic beyond enabling and
 * disabling controls.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const store = {
  get name() {
    return localStorage.getItem('reverie:name') || '';
  },
  set name(v) {
    localStorage.setItem('reverie:name', v);
  },
  tokenFor: (code) => localStorage.getItem(`reverie:token:${code}`),
  setToken: (code, token) => localStorage.setItem(`reverie:token:${code}`, token),
};

let ws = null;
let state = null;
let myId = null;
let roomCode = null;
let cardMeta = {};
let selected = null;
let reconnectDelay = 500;
let intentionalClose = false;

/* ------------------------------------------------------------------ chrome */

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 300);
  }, 3800);
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function cardSrc(cardId) {
  return `/cards/${cardId}.jpg`;
}

function cardTitle(cardId) {
  const m = cardMeta[cardId];
  return m ? `${m.title} — ${m.artist}${m.date ? `, ${m.date}` : ''}` : 'Card';
}

function openLightbox(cardId) {
  const m = cardMeta[cardId];
  $('#lightbox-img').src = cardSrc(cardId);
  $('#lightbox-img').alt = m?.title ?? 'Card artwork';
  $('#lightbox-caption').textContent = m
    ? `${m.title} · ${m.artist}${m.date ? `, ${m.date}` : ''} · ${m.source}`
    : '';
  $('#lightbox').hidden = false;
}

$('#lightbox-close').onclick = () => ($('#lightbox').hidden = true);
$('#lightbox').onclick = (e) => {
  if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#lightbox').hidden = true;
});

/**
 * A single card tile. `onPick` makes it selectable; the zoom button always
 * works so players can study the art without committing to a choice.
 */
function cardTile(cardId, { selectedNow, disabled, onPick, extraClass = '', footer } = {}) {
  const img = el('img', {
    src: cardSrc(cardId),
    alt: cardTitle(cardId),
    loading: 'lazy',
    draggable: false,
  });

  const zoom = el('button', {
    className: 'card-zoom',
    type: 'button',
    title: 'View full size',
    ariaLabel: 'View full size',
    textContent: '⤢',
    onclick: (e) => {
      e.stopPropagation();
      openLightbox(cardId);
    },
  });

  const card = el(
    'button',
    {
      type: 'button',
      className: [
        'card',
        selectedNow ? 'selected' : '',
        disabled || !onPick ? 'disabled' : '',
        extraClass,
      ]
        .filter(Boolean)
        .join(' '),
      onclick: () => {
        if (onPick && !disabled) onPick(cardId);
        else openLightbox(cardId);
      },
    },
    img,
    zoom,
  );

  return el('div', { className: 'card-wrap' }, card, footer ?? el('div', { className: 'card-foot' }));
}

/* -------------------------------------------------------------- networking */

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(code, name) {
  intentionalClose = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 500;
    send({ type: 'join', code, name, token: store.tokenFor(code) });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'joined') {
      myId = msg.playerId;
      roomCode = msg.code;
      store.setToken(msg.code, msg.token);
      history.replaceState(null, '', `/${msg.code}`);
      showScreen('screen-game');
    } else if (msg.type === 'state') {
      const previous = state;
      state = msg.state;
      if (previous?.round !== state.round || previous?.phase !== state.phase) selected = null;
      render();
    } else if (msg.type === 'error') {
      toast(msg.message, 'error');
      // The room vanished (expired, or the host closed it) — there is nothing
      // to reconnect to, so fall back to the landing screen.
      if (/room not found/i.test(msg.message)) {
        intentionalClose = true;
        hideInvitePanel();
        showScreen('screen-home');
        history.replaceState(null, '', '/');
      }
    }
  };

  ws.onclose = () => {
    if (intentionalClose) return;
    toast('Connection lost — reconnecting…', 'error');
    setTimeout(() => connect(code, store.name), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

/* ------------------------------------------------------------- game screens */

function renderPlayers() {
  const list = $('#players');
  list.replaceChildren();

  const ordered = [...state.players].sort((a, b) => b.score - a.score);
  for (const p of ordered) {
    const delta = state.scoring?.delta?.[p.id] ?? 0;
    list.append(
      el(
        'li',
        {
          className: [
            'player',
            p.id === myId ? 'is-you' : '',
            p.id === state.storytellerId ? 'is-storyteller' : '',
          ]
            .filter(Boolean)
            .join(' '),
        },
        el('span', {
          className: `dot ${!p.connected ? 'off' : p.waitingOn ? 'waiting' : ''}`,
          title: !p.connected ? 'Disconnected' : p.waitingOn ? 'Still deciding' : 'Ready',
        }),
        el('span', { className: 'player-name', title: p.name }, p.name),
        p.id === myId && el('span', { className: 'badge badge-you' }, 'you'),
        p.isHost && el('span', { className: 'badge' }, 'host'),
        p.id === state.storytellerId && el('span', { className: 'badge' }, '📖'),
        delta > 0 && el('span', { className: 'delta' }, `+${delta}`),
        el('span', { className: 'player-score' }, p.score),
      ),
    );
  }

  const log = $('#log');
  log.replaceChildren(...(state.log ?? []).map((e) => el('div', {}, e.text)));
}

function renderLobby() {
  const canStart = state.you?.isHost && state.players.length >= state.minPlayers;
  const inviteUrl = `${location.origin}/${state.code}`;

  return el(
    'div',
    { className: 'stage lobby-box' },
    el('h2', { className: 'stage-title' }, 'Waiting for players'),
    el('div', { className: 'big-code' }, state.code),
    el('p', { className: 'stage-hint' }, 'Share this code, or the link below:'),
    el(
      'div',
      { className: 'invite' },
      inviteUrl,
      el('button', {
        className: 'btn btn-sm',
        textContent: 'Copy',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(inviteUrl);
            toast('Invite link copied');
          } catch {
            toast('Copy failed — select the link manually', 'error');
          }
        },
      }),
    ),
    el(
      'p',
      { className: 'stage-hint' },
      `${state.players.length} of ${state.maxPlayers} seats filled · needs at least ${state.minPlayers}`,
    ),
    el('div', { style: 'margin-top:1.25rem' },
      state.you?.isHost
        ? el('button', {
            className: 'btn btn-primary',
            textContent: canStart ? 'Start game' : `Waiting for ${state.minPlayers - state.players.length} more…`,
            disabled: !canStart,
            onclick: () => send({ type: 'start' }),
          })
        : el('div', { className: 'waiting-note' },
            el('span', { className: 'spinner' }),
            'Waiting for the host to start…'),
    ),
  );
}

function renderClue() {
  const me = state.you;

  if (!me.isStoryteller) {
    const st = state.players.find((p) => p.id === state.storytellerId);
    return el(
      'div',
      { className: 'stage' },
      el('div', { className: 'stage-head' },
        el('h2', { className: 'stage-title' }, `${st?.name ?? 'The storyteller'} is thinking…`),
      ),
      el('div', { className: 'waiting-note' },
        el('span', { className: 'spinner' }),
        'They are choosing a card and a clue.'),
      handSection('Your hand', { pickable: false }),
    );
  }

  const input = el('input', {
    type: 'text',
    id: 'clue-input',
    maxLength: 120,
    placeholder: 'Your clue — a word, a phrase, a lyric…',
  });

  const submit = () => {
    const clue = input.value.trim();
    if (!selected) return toast('Pick a card from your hand first', 'error');
    if (!clue) return toast('Give the card a clue', 'error');
    send({ type: 'clue', clue, cardId: selected });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  return el(
    'div',
    { className: 'stage' },
    el('div', { className: 'stage-head' },
      el('h2', { className: 'stage-title' }, 'You are the storyteller'),
      el('span', { className: 'stage-hint' },
        'Aim for a clue that some — but not all — will guess.'),
    ),
    handSection('Choose a card, then write your clue', { pickable: true }),
    el('div', { className: 'actionbar' },
      input,
      el('button', { className: 'btn btn-primary', textContent: 'Tell the story', onclick: submit }),
    ),
  );
}

function renderSubmit() {
  const me = state.you;
  const need = state.cardsPerPlayer - me.submitted.length;
  const done = me.isStoryteller || need <= 0;

  return el(
    'div',
    { className: 'stage' },
    clueBanner(),
    el('div', { className: 'stage-head' },
      el('h2', { className: 'stage-title' },
        done ? 'Waiting for the others' : `Pick ${need} card${need > 1 ? 's' : ''} that fit the clue`),
      !done && el('span', { className: 'stage-hint' }, 'Try to fool the others into voting for yours.'),
    ),
    done
      ? el('div', { className: 'waiting-note' },
          el('span', { className: 'spinner' }),
          waitingOnText())
      : null,
    handSection(done ? 'Your hand' : 'Your hand', { pickable: !done }),
    !done &&
      el('div', { className: 'actionbar' },
        el('button', {
          className: 'btn btn-primary',
          textContent: 'Play this card',
          disabled: !selected,
          onclick: () => selected && send({ type: 'submit', cardId: selected }),
        }),
      ),
  );
}

function renderVote() {
  const me = state.you;
  const voted = me.votedFor != null;
  const canVote = !me.isStoryteller && !voted;

  const grid = el('div', { className: 'card-grid table-grid' });
  for (const entry of state.table) {
    const mine = me.submitted.includes(entry.cardId);
    grid.append(
      cardTile(entry.cardId, {
        selectedNow: selected === entry.cardId || me.votedFor === entry.cardId,
        disabled: !canVote || mine,
        onPick: canVote && !mine ? (id) => { selected = id; render(); } : null,
        footer: mine
          ? el('div', { className: 'card-foot' }, el('span', { className: 'owner-tag' }, 'yours'))
          : null,
      }),
    );
  }

  return el(
    'div',
    { className: 'stage' },
    clueBanner(),
    el('div', { className: 'stage-head' },
      el('h2', { className: 'stage-title' },
        me.isStoryteller ? 'The others are voting' : voted ? 'Vote locked in' : "Which card was the storyteller's?"),
      el('span', { className: 'stage-hint' },
        me.isStoryteller ? 'You sit this one out.' : 'You cannot vote for your own card.'),
    ),
    (me.isStoryteller || voted) &&
      el('div', { className: 'waiting-note' }, el('span', { className: 'spinner' }), waitingOnText()),
    grid,
    canVote &&
      el('div', { className: 'actionbar' },
        el('button', {
          className: 'btn btn-primary',
          textContent: 'Lock in vote',
          disabled: !selected,
          onclick: () => selected && send({ type: 'vote', cardId: selected }),
        }),
      ),
  );
}

function renderReveal() {
  const s = state.scoring;
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '—';
  const banner = {
    'all-found': 'Everyone found it — too easy! The storyteller scores nothing.',
    'none-found': 'Nobody found it — too cryptic! The storyteller scores nothing.',
    split: 'A good clue — some found it, some did not.',
  }[s.outcome];

  const grid = el('div', { className: 'card-grid table-grid' });
  for (const entry of state.table) {
    const isStory = entry.isStorytellerCard;
    grid.append(
      cardTile(entry.cardId, {
        disabled: true,
        extraClass: isStory ? 'storyteller-card' : '',
        footer: el(
          'div',
          { className: 'card-foot' },
          el(
            'span',
            { className: `owner-tag ${isStory ? 'is-storyteller' : ''}` },
            isStory ? `📖 ${nameOf(entry.owner)}` : nameOf(entry.owner),
          ),
          el(
            'div',
            { className: 'voter-chips' },
            entry.voters.map((v) => el('span', { className: 'chip' }, nameOf(v))),
          ),
        ),
      }),
    );
  }

  return el(
    'div',
    { className: 'stage' },
    clueBanner(),
    el('div', { className: `result-banner ${s.outcome}` }, banner),
    grid,
    el('div', { className: 'actionbar' },
      state.you?.isHost
        ? el('button', {
            className: 'btn btn-primary',
            textContent: 'Next round',
            onclick: () => send({ type: 'next' }),
          })
        : el('div', { className: 'waiting-note' },
            el('span', { className: 'spinner' }),
            'Waiting for the host to deal the next round…'),
    ),
  );
}

function renderFinished() {
  const ordered = [...state.players].sort((a, b) => b.score - a.score);
  const winnerNames = state.winners
    .map((id) => state.players.find((p) => p.id === id)?.name)
    .filter(Boolean);

  return el(
    'div',
    { className: 'stage' },
    el('h2', { className: 'stage-title', style: 'text-align:center' },
      winnerNames.length > 1 ? `🏆 It's a tie: ${winnerNames.join(' & ')}` : `🏆 ${winnerNames[0]} wins!`),
    el(
      'div',
      { className: 'podium' },
      ordered.map((p, i) =>
        el(
          'div',
          { className: `podium-row ${state.winners.includes(p.id) ? 'winner' : ''}` },
          el('span', { className: 'podium-rank' }, `${i + 1}.`),
          el('span', { className: 'player-name' }, p.name),
          el('span', { className: 'player-score' }, p.score),
        ),
      ),
    ),
    el('div', { style: 'text-align:center;margin-top:1.25rem' },
      state.you?.isHost
        ? el('button', {
            className: 'btn btn-primary',
            textContent: 'Play again',
            onclick: () => send({ type: 'playAgain' }),
          })
        : el('span', { className: 'stage-hint' }, 'Waiting for the host to start another game…'),
    ),
  );
}

function clueBanner() {
  if (!state.clue) return null;
  return el(
    'div',
    { className: 'clue-display' },
    el('div', { className: 'clue-label' }, 'The clue'),
    el('div', { className: 'clue-text' }, `“${state.clue}”`),
  );
}

function waitingOnText() {
  const names = state.players.filter((p) => p.waitingOn).map((p) => p.name);
  if (names.length === 0) return 'Just a moment…';
  if (names.length === 1) return `Waiting for ${names[0]}…`;
  if (names.length <= 3) return `Waiting for ${names.join(', ')}…`;
  return `Waiting for ${names.length} players…`;
}

function handSection(title, { pickable }) {
  const me = state.you;
  if (!me) return null;
  const grid = el('div', { className: 'card-grid' });
  for (const cardId of me.hand) {
    grid.append(
      cardTile(cardId, {
        selectedNow: selected === cardId,
        disabled: !pickable,
        onPick: pickable ? (id) => { selected = id; render(); } : null,
      }),
    );
  }
  return el('div', { style: 'margin-top:1.25rem' },
    el('div', { className: 'hand-title' }, title),
    grid);
}

/* ------------------------------------------------------------------ render */

function render() {
  if (!state) return;

  const narrow = window.matchMedia('(max-width: 860px)').matches;
  $('#room-code').textContent = state.code;
  $('#round-label').textContent =
    state.phase === 'lobby'
      ? 'Lobby'
      : narrow
        ? `Round ${state.round}`
        : `Round ${state.round} · first to ${state.targetScore}`;
  $('#deck-count').textContent = state.phase === 'lobby' ? '' : `${state.deckRemaining} cards left`;

  renderPlayers();

  const main = $('#main');
  const view =
    {
      lobby: renderLobby,
      clue: renderClue,
      submit: renderSubmit,
      vote: renderVote,
      reveal: renderReveal,
      finished: renderFinished,
    }[state.phase] ?? renderLobby;

  main.replaceChildren(view());
}

/* ------------------------------------------------------------------ events */

$('#room-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/${roomCode}`);
    toast('Invite link copied');
  } catch {
    toast('Copy failed', 'error');
  }
};

$('#btn-leave').onclick = () => {
  if (!confirm('Leave this game?')) return;
  intentionalClose = true;
  send({ type: 'leave' });
  ws?.close();
  state = null;
  history.replaceState(null, '', '/');
  showScreen('screen-home');
};

$('#btn-create').onclick = async () => {
  const name = $('#name-input').value.trim();
  if (!name) return toast('Enter a name first', 'error');
  store.name = name;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { code } = await res.json();
    connect(code, name);
  } catch {
    toast('Could not reach the server', 'error');
  }
};

$('#join-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#name-input').value.trim();
  const code = $('#code-input').value.trim().toUpperCase();
  if (!name) return toast('Enter a name first', 'error');
  if (!code) return toast('Enter a room code', 'error');
  store.name = name;
  connect(code, name);
};

/* ------------------------------------------------------------------ invite */

/**
 * Arriving via /ABCD means the player has exactly one intent: join that room.
 * Show a panel built around that single action, and check the room actually
 * has space before they commit to typing a name.
 */
function showInvitePanel(code) {
  $('#panel-default').hidden = true;
  $('#panel-invite').hidden = false;
  $('#invite-code').textContent = code;
  $('#invite-name').value = store.name;

  const status = $('#invite-status');
  const button = $('#btn-join-invite');

  const setStatus = (text, problem = false) => {
    status.textContent = text;
    status.classList.toggle('problem', problem);
  };

  setStatus('Checking the room…');
  button.disabled = true;

  fetch(`/api/rooms/${code}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('missing'))))
    .then((info) => {
      const seats = `${info.players} of ${info.maxPlayers} players`;
      if (info.canJoin) {
        setStatus(`${seats} waiting in the lobby.`);
        button.disabled = false;
      } else if (info.phase !== 'lobby') {
        // A returning player still holds a token, so let them back in.
        const returning = Boolean(store.tokenFor(code));
        setStatus(
          returning
            ? `${seats} · game in progress — rejoin your seat.`
            : 'That game has already started, so it cannot take new players.',
          !returning,
        );
        button.disabled = !returning;
      } else {
        setStatus('That room is full.', true);
        button.disabled = true;
      }
    })
    .catch(() => {
      setStatus('That room no longer exists — it may have expired.', true);
      button.disabled = true;
    });

  if (!store.name) setTimeout(() => $('#invite-name').focus(), 50);
}

function hideInvitePanel() {
  $('#panel-invite').hidden = true;
  $('#panel-default').hidden = false;
}

$('#invite-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#invite-name').value.trim();
  const code = $('#invite-code').textContent.trim();
  if (!name) return toast('Enter your name to join', 'error');
  store.name = name;
  connect(code, name);
};

$('#btn-start-instead').onclick = () => {
  hideInvitePanel();
  $('#name-input').value = $('#invite-name').value.trim() || store.name;
  history.replaceState(null, '', '/');
};

$('#link-credits').onclick = (e) => {
  e.preventDefault();
  renderCredits();
  showScreen('screen-credits');
};

$('#btn-credits-back').onclick = () => showScreen('screen-home');

function renderCredits() {
  const entries = Object.entries(cardMeta);
  $('#credits-summary').textContent =
    `${entries.length} public-domain works. Every image is used under the open-access terms of the holding institution.`;
  const grid = $('#credits-grid');
  grid.replaceChildren(
    ...entries.map(([id, m]) =>
      el(
        'div',
        { className: 'credit-card' },
        el('img', { src: cardSrc(id), alt: m.title, loading: 'lazy' }),
        el('p', {},
          el('strong', {}, m.title),
          `${m.artist}${m.date ? `, ${m.date}` : ''}`,
          el('br'),
          m.source),
      ),
    ),
  );
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  $('#name-input').value = store.name;

  try {
    const res = await fetch('/api/cards');
    cardMeta = (await res.json()).cards;
  } catch {
    toast('Could not load the deck', 'error');
  }

  // /ABCD deep link — an invite, or a refresh of a game we are already in.
  const match = location.pathname.match(/^\/([A-Z0-9]{4})$/);
  if (match) {
    const code = match[1];
    if (store.name && store.tokenFor(code)) {
      // Returning to a seat we already hold: reconnect without asking again.
      connect(code, store.name);
    } else {
      showInvitePanel(code);
    }
  }
}

boot();
