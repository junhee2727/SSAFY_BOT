import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../../src/config/config.ts';
import { createApplication } from '../../src/runtime/application.ts';
import { environment, settings, temporaryDirectory } from '../helpers.ts';

test('SQLite persists data across restarts and close is idempotent', (context) => {
  const directory = temporaryDirectory(context);
  const config = parseConfig(settings(), environment(), directory);
  const first = createApplication(config);
  try {
    first.database.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES ('persisted');");
    assert.equal(first.database.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  } finally {
    first.close();
    first.close();
  }
  const second = createApplication(config);
  try {
    assert.equal(second.database.prepare('SELECT value FROM probe').get()?.value, 'persisted');
  } finally {
    second.close();
  }
});

test('mail and summary failures do not prevent a task operation', async (context) => {
  const directory = temporaryDirectory(context);
  const messages: string[] = [];
  const app = createApplication(parseConfig(settings(), environment(), directory), {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  });
  try {
    for (const feature of ['mail', 'summary'] as const) {
      assert.equal(await app.features.run(feature, async () => {
        throw new Error('private-token and private-email-body');
      }), false);
      assert.equal(app.features.status(feature).state, 'failed');
    }
    assert.equal(await app.features.run('tasks', async () => {
      app.database.exec('CREATE TABLE task_probe (id INTEGER)');
    }), true);
    assert.equal(app.features.status('tasks').state, 'succeeded');
    assert.doesNotMatch(messages.join(' '), /private-token|private-email-body/);
    assert.equal(await app.features.run('mail', async () => {}), true);
    assert.equal(app.features.status('mail').state, 'succeeded');
  } finally {
    app.close();
  }
});
