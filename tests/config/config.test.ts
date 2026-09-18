import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseConfig } from '../../src/config/config.ts';
import { environment, settings, temporaryDirectory } from '../helpers.ts';

test('defaults support core startup without mail or GMS credentials', () => {
  const config = parseConfig(settings(), environment(), process.cwd());
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.equal(config.databasePath, resolve('data/bot.sqlite'));
  assert.deepEqual(config.newsletter, { enabled: false });
  assert.deepEqual(config.gms, { enabled: false });
  assert.deepEqual(config.warnings, []);
});

test('login ID is normalized and password whitespace is preserved', () => {
  const config = parseConfig(settings(), {
    MATTERMOST_URL: 'https://mattermost.example.test',
    MATTERMOST_LOGIN_ID: ' reader ',
    MATTERMOST_PASSWORD: ' password#with-spaces ',
  }, process.cwd());
  assert.equal(config.mattermost.loginId, 'reader');
  assert.equal(config.mattermost.password, ' password#with-spaces ');
});

test('password login requires HTTPS and validates MFA format', () => {
  const env = {
    MATTERMOST_URL: 'http://mattermost.example.test',
    MATTERMOST_LOGIN_ID: 'reader', MATTERMOST_PASSWORD: 'private-password',
  };
  assert.throws(() => parseConfig(settings(), env, process.cwd()), /HTTPS/);
  env.MATTERMOST_URL = 'https://mattermost.example.test';
  assert.throws(() => parseConfig(settings(), { ...env, MATTERMOST_MFA_TOKEN: 'secret' }, process.cwd()), /6자리/);
});

for (const key of ['MATTERMOST_URL', 'MATTERMOST_LOGIN_ID', 'MATTERMOST_PASSWORD']) {
  test(`missing ${key} fails startup`, () => {
    const env = environment();
    delete env[key];
    assert.throws(() => parseConfig(settings(), env, process.cwd()), new RegExp(key));
  });
}

test('credentials in a Mattermost URL are rejected without echoing them', () => {
  const env = { ...environment(), MATTERMOST_URL: 'https://user:private-password@example.test' };
  assert.throws(() => parseConfig(settings(), env, process.cwd()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /MATTERMOST_URL/);
    assert.doesNotMatch(error.message, /private-password/);
    return true;
  });
});

test('timezone and persistent database path are validated', () => {
  const raw = settings();
  raw.timezone = 'UTC';
  assert.throws(() => parseConfig(raw, environment(), process.cwd()), /timezone/);
  raw.timezone = 'Asia/Seoul';
  raw.database.path = ':memory:';
  assert.throws(() => parseConfig(raw, environment(), process.cwd()), /database.path/);
});

test('mail and GMS missing credentials only disable those features', () => {
  const raw = settings();
  raw.newsletter.enabled = true;
  raw.gms.enabled = true;
  const config = parseConfig(raw, environment(), process.cwd());
  assert.deepEqual(config.newsletter, { enabled: false });
  assert.deepEqual(config.gms, { enabled: false });
  assert.equal(config.warnings.length, 2);
  assert.equal(config.mattermost.loginId, 'test-only-user');
});

test('enabled optional integrations produce usable config', () => {
  const raw = settings();
  raw.newsletter.enabled = true;
  raw.newsletter.allowedSenders = ['news@example.test', 'news@example.test'];
  raw.gms.enabled = true;
  const config = parseConfig(raw, {
    ...environment(),
    NAVER_EMAIL: 'reader@naver.com',
    NAVER_APP_PASSWORD: 'test-mail-secret',
    GMS_KEY: 'test-gms-secret',
  }, process.cwd());
  assert.ok(config.newsletter.enabled);
  assert.deepEqual(config.newsletter.allowedSenders, ['news@example.test']);
  assert.equal(config.newsletter.deliveryTime, '09:00');
  assert.equal(config.newsletter.pollIntervalSeconds, 300);
  assert.ok(config.gms.enabled);
  assert.equal(config.gms.endpoint,
    'https://gms.ssafy.io/gmsapi/generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  assert.deepEqual(config.warnings, []);
});

test('empty sender list explicitly pauses collection', () => {
  const raw = settings();
  raw.newsletter.enabled = true;
  const config = parseConfig(raw, {
    ...environment(), NAVER_EMAIL: 'reader@naver.com', NAVER_APP_PASSWORD: 'test-secret',
  }, process.cwd());
  assert.ok(config.newsletter.enabled);
  assert.deepEqual(config.newsletter.allowedSenders, []);
  assert.match(config.warnings[0]!, /수집하지 않습니다/);
});

for (const [field, value] of [
  ['deliveryTime', '24:00'],
  ['deliveryTime', '9:00'],
  ['pollIntervalSeconds', 0],
  ['allowedSenders', ['not-an-address']],
  ['enabled', 'true'],
] as const) {
  test(`invalid newsletter ${field} is isolated`, () => {
    const raw = settings();
    raw.newsletter.enabled = true;
    raw.newsletter[field] = value;
    const config = parseConfig(raw, environment(), process.cwd());
    assert.deepEqual(config.newsletter, { enabled: false });
    assert.match(config.warnings[0]!, new RegExp(field));
  });
}

test('GMS requires HTTPS and does not leak a rejected endpoint', () => {
  const raw = settings();
  raw.gms.enabled = true;
  raw.gms.baseUrl = 'http://example.test?key=private-key';
  const config = parseConfig(raw, { ...environment(), GMS_KEY: 'private-key' }, process.cwd());
  assert.deepEqual(config.gms, { enabled: false });
  assert.doesNotMatch(config.warnings.join(' '), /private-key/);
});

test('custom config file and BOM are supported; database path is relative to cwd', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(join(directory, 'custom.json'), '\uFEFF' + JSON.stringify(settings()));
  const config = loadConfig({ ...environment(), BOT_CONFIG_PATH: 'custom.json' }, directory);
  assert.equal(config.databasePath, join(directory, 'data', 'bot.sqlite'));
});

test('missing or malformed JSON fails with a safe actionable error', (context) => {
  const directory = temporaryDirectory(context);
  const env = { ...environment(), BOT_CONFIG_PATH: 'broken.json' };
  assert.throws(() => loadConfig(env, directory), /BOT_CONFIG_PATH/);
  writeFileSync(join(directory, 'broken.json'), '{"password":"private-secret",');
  assert.throws(() => loadConfig(env, directory), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /JSON/);
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
});
