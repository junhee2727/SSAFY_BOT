import type { CommandHandler } from '../commands/router.ts';
import { MattermostConnectionError } from './client.ts';
import type { Identity, Post } from './client.ts';
import { TransportStore } from './store.ts';

export interface MessageApi {
  page(channelId: string, before?: string): Promise<Post[]>;
  send(channelId: string, message: string, deliveryId: string): Promise<Post>;
}

export function isUserPost(post: Post, identity: Identity): boolean {
  return post.channel_id === identity.channelId && post.user_id === identity.userId
    && !post.delete_at && !post.type && post.props.ssafy_bot !== true;
}

// Use backward ID pagination; "since" is capped and page offsets can move.
// Include the boundary timestamp so equal-time events are not lost.
export async function history(api: MessageApi, channelId: string, since: number): Promise<Post[]> {
  const posts = new Map<string, Post>();
  const anchors = new Set<string>();
  let before: string | undefined;
  while (true) {
    const page = await api.page(channelId, before);
    if (!page.length) break;
    for (const post of page) if (post.create_at >= since) posts.set(post.id, post);
    if (page.some((post) => post.create_at < since)) break;
    const next = page.at(-1)!.id;
    if (anchors.has(next)) throw new MattermostConnectionError('Mattermost 대화 이력 조회가 진행되지 않습니다.', 0, true);
    anchors.add(next);
    before = next;
  }
  return [...posts.values()].sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id));
}

export class MessageProcessor {
  private readonly api: MessageApi;
  private readonly identity: Identity;
  private readonly store: TransportStore;
  private readonly handler: CommandHandler;

  constructor(api: MessageApi, identity: Identity, store: TransportStore, handler: CommandHandler) {
    this.api = api;
    this.identity = identity;
    this.store = store;
    this.handler = handler;
  }

  async initialize(): Promise<void> {
    if (this.store.cursor() !== undefined) return;
    const first = await this.api.page(this.identity.channelId);
    if (!first.length) {
      this.store.initialize([]);
      return;
    }
    const newest = Math.max(...first.map((post) => post.create_at));
    const baseline = await history(this.api, this.identity.channelId, newest);
    this.store.initialize([...first, ...baseline]);
  }

  async synchronize(): Promise<void> {
    const cursor = this.store.cursor();
    if (cursor === undefined) throw new Error('Transport store is not initialized');
    const posts = await history(this.api, this.identity.channelId, cursor);
    for (const post of posts) {
      if (isUserPost(post, this.identity) && !this.store.isSentPost(post.id)) {
        this.store.accept(post, this.handler);
      }
    }
    this.store.checkpoint(posts.reduce((time, post) => Math.max(time, post.create_at), cursor));
    await this.deliver();
  }

  private async deliver(): Promise<void> {
    for (const delivery of this.store.pending()) {
      if (delivery.attempts > 0) {
        const posts = await history(this.api, this.identity.channelId, delivery.source_at);
        const existing = posts.find((post) => post.user_id === this.identity.userId
          && post.channel_id === this.identity.channelId && !post.delete_at
          && post.props.ssafy_delivery_id === delivery.delivery_id);
        if (existing) {
          this.store.sent(delivery.delivery_id, existing.id);
          continue;
        }
      }
      this.store.attempted(delivery.delivery_id);
      const post = await this.api.send(this.identity.channelId, delivery.message, delivery.delivery_id);
      this.store.sent(delivery.delivery_id, post.id);
    }
  }
}
