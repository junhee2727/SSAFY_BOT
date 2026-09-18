import type { MattermostConfig } from '../config/config.ts';

export class MattermostConnectionError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'MattermostConnectionError';
    this.status = status;
    this.retryable = retryable;
  }
}

export type HttpFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface Identity { userId: string; channelId: string }
export interface Post {
  id: string;
  user_id: string;
  channel_id: string;
  create_at: number;
  delete_at: number;
  message: string;
  type: string;
  props: Record<string, unknown>;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MattermostConnectionError('Mattermost 응답 형식이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

export function responseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{26}$/.test(value)) {
    throw new MattermostConnectionError('Mattermost 응답에 올바른 ID가 없습니다.');
  }
  return value;
}

export function parsePost(value: unknown): Post {
  const post = object(value);
  if (typeof post.message !== 'string' || typeof post.create_at !== 'number'
    || !Number.isSafeInteger(post.create_at) || post.create_at < 0) {
    throw new MattermostConnectionError('Mattermost 게시물 응답 형식이 올바르지 않습니다.');
  }
  return {
    id: responseId(post.id), user_id: responseId(post.user_id),
    channel_id: responseId(post.channel_id), create_at: post.create_at,
    message: post.message, type: typeof post.type === 'string' ? post.type : '',
    delete_at: typeof post.delete_at === 'number' ? post.delete_at : 0,
    props: post.props ? object(post.props) : {},
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return object(await response.json());
  } catch {
    throw new MattermostConnectionError('Mattermost 응답을 읽을 수 없습니다. 서버 주소와 연결 상태를 확인하세요.', 0, true);
  }
}

export class MattermostClient {
  #token = '';
  readonly config: MattermostConfig;
  private readonly fetcher: HttpFetch;
  private readonly signal: AbortSignal | undefined;

  constructor(config: MattermostConfig, fetcher: HttpFetch = fetch, signal?: AbortSignal) {
    this.config = config;
    this.fetcher = fetcher;
    this.signal = signal;
  }

  get websocketUrl(): string {
    return this.config.url.replace(/^https:/, 'wss:') + '/api/v4/websocket';
  }

  authenticationFrame(): string {
    if (!this.#token) throw new MattermostConnectionError('Mattermost 로그인이 필요합니다.');
    return JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: this.#token } });
  }

  private async request(path: string, method: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      response = await this.fetcher(this.config.url + '/api/v4' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.#token ? { Authorization: 'Bearer ' + this.#token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: this.signal && path !== '/users/logout'
          ? AbortSignal.any([timeout, this.signal]) : timeout,
      });
    } catch {
      throw new MattermostConnectionError('Mattermost 연결 실패. 서버 주소, 네트워크, 인증서 또는 응답 시간을 확인하세요.', 0, true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (path === '/users/login') {
        throw new MattermostConnectionError('Mattermost 로그인 실패. 아이디·비밀번호, 추가 인증(MATTERMOST_MFA_TOKEN), 서버 로그인 정책을 확인하세요.', response.status);
      }
      if (response.status === 401) {
        throw new MattermostConnectionError('Mattermost 인증이 만료되었거나 유효하지 않습니다.', 401);
      }
      if (response.status === 403) {
        throw new MattermostConnectionError('Mattermost 접근 권한이 없습니다. DM 사용 권한을 확인하세요.', 403);
      }
      if (response.status === 429) {
        throw new MattermostConnectionError('Mattermost 요청 제한에 도달했습니다. 잠시 후 다시 실행하세요.', 429, true);
      }
      throw new MattermostConnectionError('Mattermost 요청 실패. 서버 상태와 주소를 확인하세요.', response.status, response.status >= 500);
    }
    return response;
  }

  async login(): Promise<Identity> {
    this.#token = '';
    const response = await this.request('/users/login', 'POST', {
      login_id: this.config.loginId, password: this.config.password,
      ...(this.config.mfaToken ? { token: this.config.mfaToken } : {}),
    });
    this.#token = response.headers.get('Token')?.trim() ?? '';
    if (!this.#token) {
      await response.body?.cancel().catch(() => {});
      throw new MattermostConnectionError('로그인 응답에 세션 토큰이 없습니다. 서버 또는 프록시 설정을 확인하세요.');
    }
    const userId = responseId((await json(response)).id);
    const channel = await json(await this.request('/channels/direct', 'POST', [userId, userId]));
    const channelId = responseId(channel.id);
    if (channel.type !== 'D') throw new MattermostConnectionError('Mattermost에서 DM 채널을 확인하지 못했습니다.');
    return { userId, channelId };
  }

  async verifySession(): Promise<void> {
    await json(await this.request('/users/me', 'GET'));
  }

  async logout(): Promise<void> {
    if (!this.#token) return;
    try {
      const response = await this.request('/users/logout', 'POST');
      await response.body?.cancel();
    } finally {
      this.#token = '';
    }
  }

  async page(channelId: string, before?: string): Promise<Post[]> {
    const query = new URLSearchParams({ per_page: '100' });
    if (before) query.set('before', responseId(before));
    const result = await json(await this.request('/channels/' + responseId(channelId) + '/posts?' + query, 'GET'));
    if (!Array.isArray(result.order)) throw new MattermostConnectionError('Mattermost 게시물 목록 형식이 올바르지 않습니다.');
    const posts = object(result.posts);
    return result.order.map((id) => {
      const post = parsePost(posts[responseId(id)]);
      if (post.channel_id !== channelId || post.id !== id) {
        throw new MattermostConnectionError('Mattermost 게시물의 채널 또는 ID가 일치하지 않습니다.');
      }
      return post;
    });
  }

  async send(channelId: string, message: string, deliveryId: string): Promise<Post> {
    const post = parsePost(await json(await this.request('/posts', 'POST', {
      channel_id: responseId(channelId), message,
      props: { ssafy_bot: true, ssafy_delivery_id: deliveryId },
    })));
    if (post.channel_id !== channelId) throw new MattermostConnectionError('발송 응답의 채널이 일치하지 않습니다.');
    return post;
  }
}
