import { MattermostConnectionError, object, parsePost } from './client.ts';
import type { Identity } from './client.ts';
import { isUserPost } from './processor.ts';

export interface SocketLike extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;
export interface SocketOptions {
  factory?: SocketFactory;
  handshakeMs?: number;
  heartbeatMs?: number;
}

export class LiveConnection {
  private readonly socket: SocketLike;
  private readonly listeners = new Set<() => void>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private failure: MattermostConnectionError | undefined;
  private authenticated = false;
  private sequence = 1;
  private awaitingPong: number | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private revisionValue = 0;
  private readonly cleanup: () => void;

  private constructor(
    url: string, frame: string, identity: Identity, signal: AbortSignal, options: SocketOptions,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.socket = (options.factory ?? ((address) => new WebSocket(address)))(url);
    const fail = () => this.fail(new MattermostConnectionError('Mattermost WebSocket 연결이 끊어졌습니다.', 0, true));
    const abort = () => this.close();
    const open = () => {
      try { this.socket.send(frame); } catch { fail(); }
    };
    const message = (event: Event) => {
      try {
        const data = (event as MessageEvent).data;
        if (typeof data !== 'string') return;
        const packet = object(JSON.parse(data));
        if (packet.seq_reply === 1 && !this.authenticated) {
          if (packet.status !== 'OK') {
            this.fail(new MattermostConnectionError('Mattermost WebSocket 인증에 실패했습니다.', 401));
            return;
          }
          this.authenticated = true;
          clearTimeout(this.handshake);
          this.heartbeat = setInterval(() => {
            if (this.awaitingPong !== undefined) { fail(); return; }
            this.awaitingPong = ++this.sequence;
            try {
              this.socket.send(JSON.stringify({ action: 'ping', seq: this.awaitingPong }));
            } catch { fail(); }
          }, options.heartbeatMs ?? 30_000);
          this.resolveReady();
          return;
        }
        if (!this.authenticated) return;
        if (packet.seq_reply === this.awaitingPong && this.awaitingPong !== undefined) {
          if (packet.status === 'OK') this.awaitingPong = undefined;
          else fail();
        }
        if (packet.event === 'posted') {
          const postData = object(packet.data).post;
          const post = parsePost(typeof postData === 'string' ? JSON.parse(postData) : postData);
          if (isUserPost(post, identity)) this.notify();
        }
      } catch {
        // Malformed/unrelated frames never reach handlers or logs.
      }
    };
    this.socket.addEventListener('open', open);
    this.socket.addEventListener('message', message);
    this.socket.addEventListener('close', fail);
    this.socket.addEventListener('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    this.cleanup = () => {
      clearTimeout(this.handshake);
      clearInterval(this.heartbeat);
      signal.removeEventListener('abort', abort);
      this.socket.removeEventListener('open', open);
      this.socket.removeEventListener('message', message);
      this.socket.removeEventListener('close', fail);
      this.socket.removeEventListener('error', fail);
    };
    this.handshake = setTimeout(() => this.fail(
      new MattermostConnectionError('Mattermost WebSocket 인증 응답 시간이 초과되었습니다.', 0, true),
    ), options.handshakeMs ?? 15_000);
    if (signal.aborted) this.close();
  }

  static async connect(
    url: string, frame: string, identity: Identity, signal: AbortSignal, options: SocketOptions = {},
  ): Promise<LiveConnection> {
    const connection = new LiveConnection(url, frame, identity, signal, options);
    await connection.ready;
    return connection;
  }

  get revision(): number { return this.revisionValue; }

  private notify(): void {
    this.revisionValue++;
    for (const listener of [...this.listeners]) listener();
  }

  private fail(error: MattermostConnectionError): void {
    if (this.failure) return;
    this.failure = error;
    this.cleanup();
    this.rejectReady(error);
    this.notify();
    try { this.socket.close(); } catch { /* Already closed. */ }
  }

  close(): void {
    this.fail(new MattermostConnectionError('Mattermost WebSocket 연결을 종료했습니다.'));
  }

  wait(revision: number, pollMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (this.revision !== revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal.removeEventListener('abort', finish);
        if (this.failure && !signal.aborted) reject(this.failure);
        else resolve();
      };
      const timer = setTimeout(finish, pollMs);
      this.listeners.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
