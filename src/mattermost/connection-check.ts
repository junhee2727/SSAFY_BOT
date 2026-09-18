import type { MattermostConfig } from '../config/config.ts';

export class MattermostConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MattermostConnectionError';
  }
}

export type HttpFetch = (url: string, options: RequestInit) => Promise<Response>;

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MattermostConnectionError('Mattermost 응답 형식이 올바르지 않습니다. 서버 주소를 확인하세요.');
  }
  return value as Record<string, unknown>;
}

function responseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{26}$/.test(value)) {
    throw new MattermostConnectionError('Mattermost 응답에 올바른 ID가 없습니다. 서버 주소를 확인하세요.');
  }
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return responseObject(await response.json());
  } catch {
    throw new MattermostConnectionError('Mattermost 응답을 읽을 수 없습니다. 서버 주소와 연결 상태를 확인하세요.');
  }
}

// This explicit check opens/gets a DM but never sends a message. A password
// session exists only in memory and is logged out at the end of the check.
export async function checkMattermostConnection(
  config: MattermostConfig,
  fetcher: HttpFetch = fetch,
): Promise<{ userId: string; channelId: string }> {
  let token = '';
  let completed = false;

  async function request(path: string, method: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(config.url + '/api/v4' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MattermostConnectionError('Mattermost 연결 실패. 서버 주소, 네트워크, 인증서 또는 응답 시간을 확인하세요.');
    }
    if (!response.ok) {
      // Do not print remote error bodies: they may contain personal data.
      await response.body?.cancel().catch(() => {});
      if (path === '/users/login' && [400, 401, 403].includes(response.status)) {
        throw new MattermostConnectionError('Mattermost 로그인 실패. 아이디·비밀번호, 추가 인증(MATTERMOST_MFA_TOKEN), 서버 로그인 정책을 확인하세요.');
      }
      if (response.status === 401) {
        throw new MattermostConnectionError('Mattermost 인증이 만료되었거나 유효하지 않습니다. 설정을 확인한 뒤 다시 실행하세요.');
      }
      if (response.status === 403) {
        throw new MattermostConnectionError('Mattermost 접근 권한이 없습니다. DM 사용 권한을 확인하세요.');
      }
      if (response.status === 429) {
        throw new MattermostConnectionError('Mattermost 요청 제한에 도달했습니다. 잠시 후 다시 실행하세요.');
      }
      throw new MattermostConnectionError('Mattermost 요청 실패. 서버 상태와 주소를 확인하세요.');
    }
    return response;
  }

  try {
    const response = await request('/users/login', 'POST', {
      login_id: config.loginId,
      password: config.password,
      ...(config.mfaToken ? { token: config.mfaToken } : {}),
    });
    token = response.headers.get('Token')?.trim() ?? '';
    if (!token) {
      await response.body?.cancel().catch(() => {});
      throw new MattermostConnectionError('로그인 응답에 세션 토큰이 없습니다. 서버 또는 프록시 설정을 확인하세요.');
    }
    const user = await json(response);
    const userId = responseId(user.id);
    const channel = await json(await request('/channels/direct', 'POST', [userId, userId]));
    const channelId = responseId(channel.id);
    if (channel.type !== 'D') {
      throw new MattermostConnectionError('Mattermost에서 DM 채널을 확인하지 못했습니다.');
    }
    completed = true;
    return { userId, channelId };
  } finally {
    if (token) {
      try {
        const response = await request('/users/logout', 'POST');
        await response.body?.cancel();
      } catch {
        if (completed) {
          throw new MattermostConnectionError('DM 연결은 확인했지만 검사 세션 로그아웃에 실패했습니다. Mattermost의 활성 세션을 확인하세요.');
        }
        // Preserve the original failure; never expose a session token.
      } finally {
        token = '';
      }
    }
  }
}
