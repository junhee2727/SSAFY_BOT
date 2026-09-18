import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveConnection } from '../../src/mattermost/websocket.ts';
import { FakeSocket, identity, post } from './fixtures.ts';

const frame = JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: 'private-session' } });

test('WebSocket authenticates and only owner self-DM posts wake the receiver', async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const connection = await LiveConnection.connect('wss://example.test', frame, identity, controller.signal, { factory: () => socket });
  try {
    assert.deepEqual(socket.frames[0], JSON.parse(frame));
    const revision = connection.revision;
    socket.posted({ ...post(1), user_id: 'c'.repeat(26) });
    socket.posted({ ...post(2), channel_id: 'c'.repeat(26) });
    socket.posted({ ...post(3), props: { ssafy_bot: true } });
    socket.emit({ event: 'posted', data: { post: 'invalid-json' } });
    assert.equal(connection.revision, revision);
    socket.posted(post(4));
    assert.equal(connection.revision, revision + 1);
    await connection.wait(revision, 1000, controller.signal);
  } finally { connection.close(); }
  assert.equal(socket.closed, true);
});

test('authentication failure rejects without logging raw server errors', async () => {
  const socket = new FakeSocket(false);
  const pending = LiveConnection.connect('wss://example.test', frame, identity, new AbortController().signal, { factory: () => socket });
  queueMicrotask(() => socket.emit({ status: 'FAIL', seq_reply: 1, error: 'private-session' }));
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /인증에 실패/);
    assert.doesNotMatch(error.message, /private-session/);
    return true;
  });
  assert.equal(socket.closed, true);
});

test('an aborted connection releases timers and closes the socket', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const connection = await LiveConnection.connect('wss://example.test', frame, identity, controller.signal, { factory: () => socket });
  const wait = connection.wait(connection.revision, 30_000, controller.signal);
  controller.abort();
  await wait;
  assert.equal(socket.closed, true);
});

test('missing heartbeat response makes the connection retryable', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const controller = new AbortController();
  const socket = new FakeSocket();
  const connection = await LiveConnection.connect('wss://example.test', frame, identity, controller.signal, {
    factory: () => socket, heartbeatMs: 10,
  });
  try {
    const rejection = assert.rejects(connection.wait(connection.revision, 1000, controller.signal), /연결이 끊어/);
    context.mock.timers.tick(10);
    assert.equal(socket.frames.at(-1)!.action, 'ping');
    context.mock.timers.tick(10);
    await rejection;
  } finally { connection.close(); }
});

test('handshake timeout closes an unauthenticated socket', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new FakeSocket(false);
  const pending = LiveConnection.connect('wss://example.test', frame, identity, new AbortController().signal, {
    factory: () => socket, handshakeMs: 10,
  });
  const rejection = assert.rejects(pending, /시간이 초과/);
  context.mock.timers.tick(10);
  await rejection;
  assert.equal(socket.closed, true);
});
