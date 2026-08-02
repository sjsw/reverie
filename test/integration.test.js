/**
 * End-to-end protocol test: boots the real server, connects four WebSocket
 * clients, and plays a full round including a mid-game reconnect.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (b) => {
      if (b.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (b) => process.stderr.write(b));
  });
});

after(() => server?.kill());

/** A test client that queues incoming messages so tests can await one. */
class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.queue = [];
    this.waiters = [];
    this.state = null;
    this.token = null;
    this.id = null;

    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') this.state = msg.state;
      if (msg.type === 'joined') {
        this.token = msg.token;
        this.id = msg.playerId;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  open() {
    return new Promise((resolve) => this.ws.once('open', resolve));
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for the next message of `type` (default: any). */
  next(type, timeoutMs = 5000) {
    const matches = (m) => !type || m.type === type;
    const queued = this.queue.findIndex(matches);
    if (queued !== -1) return Promise.resolve(this.queue.splice(queued, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: timed out waiting for "${type ?? 'any'}"`)),
        timeoutMs,
      );
      const waiter = (msg) => {
        if (!matches(msg)) {
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(waiter);
    });
  }

  /** Wait until this client's state satisfies `predicate`. */
  async until(predicate, timeoutMs = 5000) {
    if (this.state && predicate(this.state)) return this.state;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.next('state', deadline - Date.now());
      if (predicate(msg.state)) return msg.state;
    }
    throw new Error(`${this.name}: state predicate never satisfied`);
  }

  close() {
    this.ws.close();
  }
}

async function makeRoom(n) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetScore: 30 }),
  });
  const { code } = await res.json();

  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = new Client(`P${i}`);
    await c.open();
    c.send({ type: 'join', code, name: `Player ${i}` });
    await c.next('joined');
    clients.push(c);
  }
  // Everyone should see the full roster before we proceed.
  for (const c of clients) await c.until((s) => s.players.length === n);
  return { code, clients };
}

describe('server', () => {
  test('serves health, deck and room endpoints', async () => {
    const health = await (await fetch(`${BASE}/healthz`)).json();
    assert.equal(health.ok, true);

    const deck = await (await fetch(`${BASE}/api/cards`)).json();
    assert.ok(deck.count >= 48, `deck too small: ${deck.count}`);

    const missing = await fetch(`${BASE}/api/rooms/ZZZZZZZZ`);
    assert.equal(missing.status, 404);
  });

  test('a full round plays through to scoring', async () => {
    const { clients } = await makeRoom(4);
    const [host] = clients;

    host.send({ type: 'start' });
    for (const c of clients) await c.until((s) => s.phase === 'clue');

    const storyteller = clients.find((c) => c.state.you.isStoryteller);
    const others = clients.filter((c) => c !== storyteller);
    assert.equal(others.length, 3);
    assert.equal(storyteller.state.you.hand.length, 6);

    storyteller.send({
      type: 'clue',
      clue: 'the weight of a quiet room',
      cardId: storyteller.state.you.hand[0],
    });
    for (const c of clients) await c.until((s) => s.phase === 'submit');
    assert.equal(others[0].state.clue, 'the weight of a quiet room');

    for (const c of others) {
      c.send({ type: 'submit', cardId: c.state.you.hand[0] });
    }
    for (const c of clients) await c.until((s) => s.phase === 'vote');

    // The table is anonymous during voting.
    const table = others[0].state.table;
    assert.equal(table.length, 4);
    assert.ok(table.every((t) => t.owner === null));

    for (const c of others) {
      const own = new Set(c.state.you.submitted);
      const target = c.state.table.find((t) => !own.has(t.cardId));
      c.send({ type: 'vote', cardId: target.cardId });
    }
    for (const c of clients) await c.until((s) => s.phase === 'reveal');

    // Ownership is revealed only now.
    const revealed = clients[0].state.table;
    assert.ok(revealed.every((t) => t.owner !== null));
    assert.ok(revealed.some((t) => t.isStorytellerCard));
    assert.ok(clients[0].state.scoring);

    host.send({ type: 'next' });
    for (const c of clients) await c.until((s) => s.phase === 'clue' && s.round === 2);

    // Hands are topped back up and the storyteller has moved on.
    for (const c of clients) assert.equal(c.state.you.hand.length, 6);
    assert.notEqual(clients[0].state.storytellerId, storyteller.id);

    for (const c of clients) c.close();
  });

  test('never leaks another player\'s hand', async () => {
    const { clients } = await makeRoom(3);
    clients[0].send({ type: 'start' });
    for (const c of clients) await c.until((s) => s.phase === 'clue');

    const serialised = JSON.stringify(clients[0].state);
    for (const other of clients.slice(1)) {
      for (const card of other.state.you.hand) {
        // A card in someone else's hand must not appear in my state at all.
        if (!clients[0].state.you.hand.includes(card)) {
          assert.ok(!serialised.includes(card), `leaked card ${card}`);
        }
      }
      assert.equal(other.state.players.every((p) => p.hand === undefined), true);
    }
    for (const c of clients) c.close();
  });

  test('reconnecting with a token restores the same seat', async () => {
    const { code, clients } = await makeRoom(4);
    clients[0].send({ type: 'start' });
    for (const c of clients) await c.until((s) => s.phase === 'clue');

    const victim = clients[1];
    const { token, id } = victim;
    const handBefore = [...victim.state.you.hand];
    victim.close();

    const revived = new Client('P1-again');
    await revived.open();
    revived.send({ type: 'join', code, name: 'Player 1', token });
    const joined = await revived.next('joined');

    assert.equal(joined.playerId, id, 'should reclaim the same seat');
    const s = await revived.until((st) => st.you != null);
    assert.deepEqual(s.you.hand, handBefore, 'hand should survive the reconnect');
    assert.equal(s.players.length, 4, 'no ghost player left behind');

    revived.close();
    for (const c of clients) c.close();
  });

  test('rejects out-of-turn and invalid actions', async () => {
    const { clients } = await makeRoom(4);
    const [host, other] = clients;

    other.send({ type: 'start' });
    assert.match((await other.next('error')).message, /host/i);

    host.send({ type: 'start' });
    for (const c of clients) await c.until((s) => s.phase === 'clue');

    const storyteller = clients.find((c) => c.state.you.isStoryteller);
    const notStoryteller = clients.find((c) => !c.state.you.isStoryteller);

    notStoryteller.send({ type: 'clue', clue: 'nope', cardId: notStoryteller.state.you.hand[0] });
    assert.match((await notStoryteller.next('error')).message, /storyteller/i);

    // A card the storyteller does not hold.
    storyteller.send({ type: 'clue', clue: 'x', cardId: 'aic-000000' });
    assert.match((await storyteller.next('error')).message, /not in your hand/i);

    storyteller.send({ type: 'clue', clue: '   ', cardId: storyteller.state.you.hand[0] });
    assert.match((await storyteller.next('error')).message, /empty/i);

    for (const c of clients) c.close();
  });

  test('joining an unknown room reports an error', async () => {
    const c = new Client('lost');
    await c.open();
    c.send({ type: 'join', code: 'NOSUCHRM', name: 'Nobody' });
    assert.match((await c.next('error')).message, /not found/i);
    c.close();
  });
});
