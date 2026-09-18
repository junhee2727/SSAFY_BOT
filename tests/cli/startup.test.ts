import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { environment, settings, temporaryDirectory } from '../helpers.ts';

const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

test('CLI config check has no database or network side effects', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings()));
  const result = spawnSync(process.execPath, [entry, '--check-config'], {
    cwd: directory, encoding: 'utf8',
    env: { ...environment(), BOT_CONFIG_PATH: 'settings.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /설정 검증 완료/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-password|test-only-user/);
  assert.equal(existsSync(join(directory, 'data')), false);
});

test('storage check initializes the local database without network access', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings()));
  const result = spawnSync(process.execPath, [entry, '--check-storage'], {
    cwd: directory, encoding: 'utf8',
    env: { ...environment(), BOT_CONFIG_PATH: 'settings.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SQLite 초기화 완료/);
  assert.equal(existsSync(join(directory, 'data', 'bot.sqlite')), true);
});

test('CLI exits nonzero for missing required credentials before opening SQLite', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings()));
  const result = spawnSync(process.execPath, [entry], {
    cwd: directory, encoding: 'utf8', env: { BOT_CONFIG_PATH: 'settings.json' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MATTERMOST_URL/);
  assert.equal(existsSync(join(directory, 'data')), false);
});
