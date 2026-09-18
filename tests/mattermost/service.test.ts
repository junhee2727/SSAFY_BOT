import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runMattermost } from '../../src/mattermost/service.ts';
import { config, FakeServer, post } from './fixtures.ts';

test('disconnect catches missed commands, renews an expired session, and stops cleanly', { timeout: 3000 }, async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const server = new FakeServer();
  const controller = new AbortController();
  const logs: string[] = [];
  let ready = 0;
  await runMattermost(config, db, {
    info: (text) => logs.push(text), warn: (text) => logs.push(text), error: (text) => logs.push(text),
  }, controller.signal, {
    fetcher: server.fetcher, factory: server.factory, retryMs: 1,
    onReady: () => {
      ready++;
      if (ready === 1) {
        server.api.posts.push(post(1, '도움말'));
        server.verifyExpired = true;
        server.sockets[0]!.close();
      } else controller.abort();
    },
  });
  assert.equal(ready, 2);
  assert.equal(server.logins, 2);
  assert.equal(server.api.sent.length, 1);
  assert.equal(server.logouts, 2);
  assert.ok(server.sockets.every((socket) => socket.closed));
  assert.doesNotMatch(logs.join(' '), /private-password|private-session/);
});

test('a failed password login is attempted only once', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const server = new FakeServer();
  server.failLogin = true;
  await assert.rejects(runMattermost(config, db, console, new AbortController().signal, {
    fetcher: server.fetcher, factory: server.factory, retryMs: 1,
  }), /로그인 실패/);
  assert.equal(server.logins, 1);
  assert.equal(server.sockets.length, 0);
});

test('lost REST send response is recovered after reconnect without sending twice', { timeout: 3000 }, async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const server = new FakeServer();
  const controller = new AbortController();
  let ready = 0;
  await runMattermost(config, db, { info() {}, warn() {}, error() {} }, controller.signal, {
    fetcher: server.fetcher, factory: server.factory, retryMs: 1,
    onReady: () => {
      ready++;
      if (ready === 1) {
        const command = post(1);
        server.api.posts.push(command);
        server.api.failAfterSending = true;
        server.sockets[0]!.posted(command);
      } else controller.abort();
    },
  });
  assert.equal(server.api.sendCount, 1);
  assert.equal(server.logins, 1);
  assert.equal(server.sockets.length, 2);
});
