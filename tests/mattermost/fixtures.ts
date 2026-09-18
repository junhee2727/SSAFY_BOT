import type { Identity, Post, HttpFetch } from '../../src/mattermost/client.ts';
import type { MattermostConfig } from '../../src/config/config.ts';
import type { SocketLike } from '../../src/mattermost/websocket.ts';
import type { MessageApi } from '../../src/mattermost/processor.ts';

export const identity: Identity = { userId: 'a'.repeat(26), channelId: 'b'.repeat(26) };
export const config: MattermostConfig = {
  url: 'https://mattermost.example.test', loginId: 'test-user', password: 'private-password',
};
export function post(id: number, message = '도움말', time = id): Post {
  return {
    id: String(id).padStart(26, '0'), user_id: identity.userId, channel_id: identity.channelId,
    create_at: time, delete_at: 0, message, type: '', props: {},
  };
}

export class FakeApi implements MessageApi {
  posts: Post[] = [];
  sent: Post[] = [];
  pages = 0;
  failAfterSending = false;
  sendCount = 0;
  pageSize = 100;

  async page(_channel: string, before?: string): Promise<Post[]> {
    this.pages++;
    const sorted = [...this.posts].sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id));
    const start = before ? sorted.findIndex((item) => item.id === before) + 1 : 0;
    return sorted.slice(start, start + this.pageSize);
  }

  async send(channel: string, message: string, deliveryId: string): Promise<Post> {
    this.sendCount++;
    const result = post(100_000 + this.sendCount, message,
      this.posts.reduce((time, item) => Math.max(time, item.create_at), 0) + 1);
    result.channel_id = channel;
    result.props = { ssafy_bot: true, ssafy_delivery_id: deliveryId };
    this.sent.push(result);
    this.posts.push(result);
    if (this.failAfterSending) {
      this.failAfterSending = false;
      throw new Error('Simulated lost response');
    }
    return result;
  }
}

export class FakeSocket extends EventTarget implements SocketLike {
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  closed = false;
  autoAuthenticate: boolean;

  constructor(autoAuthenticate = true) {
    super();
    this.autoAuthenticate = autoAuthenticate;
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data);
    this.frames.push(frame);
    if (frame.action === 'authentication_challenge' && this.autoAuthenticate) {
      queueMicrotask(() => this.emit({ status: 'OK', seq_reply: 1 }));
    }
  }

  emit(packet: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
  }

  posted(value: Post): void {
    this.emit({ event: 'posted', data: { post: JSON.stringify(value) } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

export class FakeServer {
  api = new FakeApi();
  sockets: FakeSocket[] = [];
  logins = 0;
  logouts = 0;
  verifyExpired = false;
  failLogin = false;
  loginRequests: RequestInit[] = [];
  factory = () => {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  };
  fetcher: HttpFetch = async (address, options) => {
    const url = new URL(address);
    if (url.pathname.endsWith('/users/login')) {
      this.logins++;
      this.loginRequests.push(options);
      if (this.failLogin) return Response.json({ message: 'private-password' }, { status: 401 });
      return Response.json({ id: identity.userId }, { headers: { Token: 'private-session-' + this.logins } });
    }
    if (url.pathname.endsWith('/users/logout')) {
      this.logouts++;
      return Response.json({ status: 'OK' });
    }
    if (url.pathname.endsWith('/users/me')) {
      if (this.verifyExpired) {
        this.verifyExpired = false;
        return Response.json({}, { status: 401 });
      }
      return Response.json({ id: identity.userId });
    }
    if (url.pathname.endsWith('/channels/direct')) {
      return Response.json({ id: identity.channelId, type: 'D' });
    }
    if (url.pathname === '/api/v4/posts' && options.method === 'POST') {
      const body = JSON.parse(options.body as string);
      return Response.json(await this.api.send(body.channel_id, body.message, body.props.ssafy_delivery_id));
    }
    if (url.pathname.endsWith('/posts') && options.method === 'GET') {
      const page = await this.api.page(identity.channelId, url.searchParams.get('before') ?? undefined);
      return Response.json({
        order: page.map((item) => item.id),
        posts: Object.fromEntries(page.map((item) => [item.id, item])),
      });
    }
    throw new Error('Unexpected mock endpoint');
  };
}
