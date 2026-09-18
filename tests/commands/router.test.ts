import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandRouter } from '../../src/commands/router.ts';

test('help and status reflect available features without claiming unfinished functionality', () => {
  const route = createCommandRouter();
  assert.match(route(' 도움말 ', 'id')!, /준비 중/);
  assert.match(route('상태', 'id')!, /아직 연결되지 않음/);
  assert.match(route('할일 추가 공부', 'id')!, /아직 구현되지/);
  assert.match(route('뉴스레터', 'id')!, /아직 구현되지/);
  assert.match(route('도움말 extra', 'id')!, /단독/);
  assert.equal(route('개인 메모', 'id'), null);
});

test('task, newsletter and status handlers receive command text and source ID', () => {
  const calls: string[] = [];
  const handler = (text: string, id: string) => { calls.push(text + ':' + id); return 'handled'; };
  const route = createCommandRouter({ tasks: handler, newsletter: handler, status: handler });
  for (const command of ['할일 목록', '뉴스레터', '상태']) assert.equal(route(command, 'source'), 'handled');
  assert.deepEqual(calls, ['할일 목록:source', '뉴스레터:source', '상태:source']);
});
