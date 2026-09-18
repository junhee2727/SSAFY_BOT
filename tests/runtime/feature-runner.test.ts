import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeatureRunner } from '../../src/runtime/feature-runner.ts';

test('overlapping executions are skipped while other features can run', async () => {
  const runner = new FeatureRunner({ info() {}, warn() {}, error() {} });
  const barrier = Promise.withResolvers<void>();
  assert.equal(runner.status('mail').state, 'idle');
  const active = runner.run('mail', () => barrier.promise);
  assert.equal(runner.status('mail').state, 'running');
  try {
    assert.equal(await runner.run('mail', async () => assert.fail('duplicate execution')), false);
    assert.equal(await runner.run('tasks', async () => {}), true);
  } finally {
    barrier.resolve();
    await active;
  }
  assert.equal(runner.status('mail').state, 'succeeded');
});
