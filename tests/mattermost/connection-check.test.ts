import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MattermostConfig } from '../../src/config/config.ts';
import { checkMattermostConnection, MattermostConnectionError } from '../../src/mattermost/connection-check.ts';
import type { HttpFetch } from '../../src/mattermost/connection-check.ts';

const userId = 'a'.repeat(26);
const channelId = 'b'.repeat(26);
const passwordConfig: MattermostConfig = {
  url: 'https://mattermost.example.test/subpath',
  loginId: 'test-user', password: 'private-password',
};

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetcher: HttpFetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected network call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}

function login(body: unknown = { id: userId }) {
  return Response.json(body, { status: 200, headers: { Token: 'private-session' } });
}

const channel = () => Response.json({ id: channelId, type: 'D' });
const logout = () => Response.json({ status: 'OK' });

test('password login targets self DM, preserves subpath, logs out, and sends no posts', async () => {
  const { fetcher, calls } = scripted([login(), channel(), logout()]);
  assert.deepEqual(await checkMattermostConnection(passwordConfig, fetcher), { userId, channelId });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, passwordConfig.url + '/api/v4/users/login');
  assert.deepEqual(JSON.parse(calls[0]!.options.body as string),
    { login_id: 'test-user', password: 'private-password' });
  assert.equal(new Headers(calls[0]!.options.headers).has('Authorization'), false);
  assert.deepEqual(JSON.parse(calls[1]!.options.body as string), [userId, userId]);
  assert.equal(new Headers(calls[1]!.options.headers).get('Authorization'), 'Bearer private-session');
  assert.ok(calls[2]!.url.endsWith('/users/logout'));
  assert.ok(calls.every((call) => call.options.redirect === 'error' && call.options.signal));
  assert.ok(calls.every((call) => !call.url.endsWith('/posts')));
});

test('optional MFA token is passed to login', async () => {
  const { fetcher, calls } = scripted([login(), channel(), logout()]);
  await checkMattermostConnection({ ...passwordConfig, mfaToken: '123456' }, fetcher);
  assert.equal(JSON.parse(calls[0]!.options.body as string).token, '123456');
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`login HTTP ${status} is sanitized without automatic retries`, async () => {
    const { fetcher, calls } = scripted([
      Response.json({ message: 'private-password private-session' }, { status }),
    ]);
    await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), (error: unknown) => {
      assert.ok(error instanceof MattermostConnectionError);
      assert.doesNotMatch(error.message, /private-password|private-session/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('network failures do not leak passwords', async () => {
  const { fetcher } = scripted([new Error('request body private-password')]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), (error: unknown) => {
    assert.ok(error instanceof MattermostConnectionError);
    assert.doesNotMatch(error.message, /private-password/);
    assert.match(error.message, /연결 실패/);
    return true;
  });
});

test('missing login token prevents further requests', async () => {
  const { fetcher, calls } = scripted([Response.json({ id: userId })]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /세션 토큰/);
  assert.equal(calls.length, 1);
});

test('malformed login response still logs out the created session', async () => {
  const { fetcher, calls } = scripted([
    new Response('private-broken-json', { headers: { Token: 'private-session' } }), logout(),
  ]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /응답을 읽을 수 없습니다/);
  assert.ok(calls[1]!.url.endsWith('/users/logout'));
});

test('invalid user IDs never reach direct channel creation', async () => {
  const { fetcher, calls } = scripted([login({ id: '../private-user' }), logout()]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /올바른 ID/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.url.endsWith('/users/logout'));
});

test('direct channel failures clean up the password session', async () => {
  const { fetcher, calls } = scripted([login(), new Response(null, { status: 403 }), logout()]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /DM 사용 권한/);
  assert.ok(calls[2]!.url.endsWith('/users/logout'));
});

test('an expired password session stops and does not attempt repeated logins', async () => {
  const { fetcher, calls } = scripted([
    login(), new Response(null, { status: 401 }), new Response(null, { status: 401 }),
  ]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /인증이 만료/);
  assert.equal(calls.filter((call) => call.url.endsWith('/users/login')).length, 1);
});

test('a non-DM response cannot pass the check', async () => {
  const { fetcher } = scripted([login(), Response.json({ id: channelId, type: 'O' }), logout()]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /DM 채널/);
});

test('logout failure is reported rather than silently reporting full success', async () => {
  const { fetcher } = scripted([login(), channel(), new Error('private-session')]);
  await assert.rejects(checkMattermostConnection(passwordConfig, fetcher), /검사 세션 로그아웃에 실패/);
});
