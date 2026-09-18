import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCommandRouter } from '../../src/commands/router.ts';
import { history, MessageProcessor } from '../../src/mattermost/processor.ts';
import { TransportStore } from '../../src/mattermost/store.ts';
import { FakeApi, identity, post } from './fixtures.ts';

test('initial history is ignored; repeated events and own replies never loop', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const api = new FakeApi();
  api.posts.push(post(1));
  const store = new TransportStore(db, 'test');
  const processor = new MessageProcessor(api, identity, store, createCommandRouter());
  await processor.initialize();
  await processor.synchronize();
  assert.equal(api.sent.length, 0);
  api.posts.push(post(2));
  await processor.synchronize();
  await processor.synchronize();
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.message, /사용 가능한 명령/);
  assert.equal(store.pending().length, 0);
});

test('only owner commands in the self DM are routed; notes and system posts are ignored', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const api = new FakeApi();
  const store = new TransportStore(db, 'test');
  const processor = new MessageProcessor(api, identity, store, createCommandRouter());
  await processor.initialize();
  api.posts.push(
    { ...post(1), user_id: 'c'.repeat(26) },
    { ...post(2), channel_id: 'c'.repeat(26) },
    { ...post(3), type: 'system_join_channel' },
    { ...post(4), delete_at: 10 },
    { ...post(5), props: { ssafy_bot: true } },
    post(6, '오늘 읽을 책 메모'),
    post(7, '상태'),
  );
  await processor.synchronize();
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0]!.message, /연결 정상/);
});

test('restart reuses receipts and catches commands received while offline, including tied timestamps', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const api = new FakeApi();
  const store = new TransportStore(db, 'test');
  const first = new MessageProcessor(api, identity, store, createCommandRouter());
  await first.initialize();
  api.posts.push(post(1));
  await first.synchronize();
  const cursor = store.cursor()!;
  api.posts.push(post(2, '상태', cursor));
  const second = new MessageProcessor(api, identity, new TransportStore(db, 'test'), createCommandRouter());
  await second.initialize();
  await second.synchronize();
  assert.equal(api.sent.length, 2);
  await second.synchronize();
  assert.equal(api.sent.length, 2);
});

test('lost send response is reconciled using persisted delivery ID after restart', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const api = new FakeApi();
  let handled = 0;
  const handler = () => { handled++; return '응답'; };
  const store = new TransportStore(db, 'test');
  const processor = new MessageProcessor(api, identity, store, handler);
  await processor.initialize();
  api.posts.push(post(1));
  api.failAfterSending = true;
  await assert.rejects(processor.synchronize(), /lost response/);
  assert.equal(store.pending()[0]!.attempts, 1);
  const restarted = new MessageProcessor(api, identity, new TransportStore(db, 'test'), handler);
  await restarted.synchronize();
  assert.equal(handled, 1);
  assert.equal(api.sendCount, 1);
  assert.equal(store.pending().length, 0);
});

test('stored sent post IDs also prevent loops if remote props are absent', async (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const api = new FakeApi();
  const processor = new MessageProcessor(api, identity, new TransportStore(db, 'test'), () => '도움말');
  await processor.initialize();
  api.posts.push(post(1));
  await processor.synchronize();
  api.sent[0]!.props = {};
  await processor.synchronize();
  assert.equal(api.sendCount, 1);
});

test('ID pagination recovers more than 1000 posts with an inclusive time boundary', async () => {
  const api = new FakeApi();
  api.posts = Array.from({ length: 1105 }, (_, index) => post(index + 1, '도움말', 100));
  const result = await history(api, identity.channelId, 100);
  assert.equal(result.length, 1105);
  assert.equal(result[0]!.id, post(1).id);
  assert.ok(api.pages > 10);
});

test('handler changes roll back with receipts and outbox when the handler fails', (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('CREATE TABLE task_probe (value INTEGER)');
  const store = new TransportStore(db, 'test');
  store.initialize([]);
  assert.throws(() => store.accept(post(1), () => {
    db.exec('INSERT INTO task_probe VALUES (1)');
    throw new Error('handler failure');
  }), /handler failure/);
  assert.equal(db.prepare('SELECT count(*) AS count FROM task_probe').get()!.count, 0);
  assert.equal(store.pending().length, 0);
  store.accept(post(1), () => 'retry');
  assert.equal(store.pending().length, 1);
});

test('transport state is separated by server/account scope', (context) => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const first = new TransportStore(db, 'server-account-one');
  const second = new TransportStore(db, 'server-account-two');
  first.initialize([]);
  first.accept(post(1), () => 'reply');
  assert.equal(second.cursor(), undefined);
  assert.equal(second.pending().length, 0);
});
