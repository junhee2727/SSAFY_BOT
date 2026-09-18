import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { MattermostConfig } from '../config/config.ts';
import { createCommandRouter } from '../commands/router.ts';
import type { CommandHandler } from '../commands/router.ts';
import type { Logger } from '../runtime/feature-runner.ts';
import { MattermostClient, MattermostConnectionError } from './client.ts';
import type { HttpFetch, Identity } from './client.ts';
import { LiveConnection } from './websocket.ts';
import type { SocketOptions } from './websocket.ts';
import { MessageProcessor } from './processor.ts';
import { TransportStore } from './store.ts';

export interface ServiceOptions extends SocketOptions {
  fetcher?: HttpFetch;
  handler?: CommandHandler;
  retryMs?: number;
  pollMs?: number;
  onReady?: () => void;
}

function sameIdentity(first: Identity, second: Identity): boolean {
  return first.userId === second.userId && first.channelId === second.channelId;
}

export async function runMattermost(
  config: MattermostConfig, db: DatabaseSync, logger: Logger,
  signal: AbortSignal, options: ServiceOptions = {},
): Promise<void> {
  const client = new MattermostClient(config, options.fetcher, signal);
  let connection: LiveConnection | undefined;
  let retries = 0;
  let renewed = false;
  try {
    const identity = await client.login();
    const scope = createHash('sha256').update(config.url + '|' + identity.userId + '|' + identity.channelId).digest('hex');
    const store = new TransportStore(db, scope);
    const processor = new MessageProcessor(client, identity, store, options.handler ?? createCommandRouter());
    while (!signal.aborted) {
      try {
        connection = await LiveConnection.connect(
          client.websocketUrl, client.authenticationFrame(), identity, signal, options,
        );
        await processor.initialize();
        let announced = false;
        while (!signal.aborted) {
          const revision = connection.revision;
          await processor.synchronize();
          retries = 0;
          renewed = false;
          if (!announced) {
            logger.info('Mattermost 연결 완료. 나와의 대화에서 도움말 또는 상태를 입력하세요.');
            options.onReady?.();
            announced = true;
          }
          await connection.wait(revision, options.pollMs ?? 30_000, signal);
        }
      } catch (caught) {
        connection?.close();
        connection = undefined;
        if (signal.aborted) break;
        let error = caught;
        if (error instanceof MattermostConnectionError && error.retryable) {
          try { await client.verifySession(); } catch (sessionError) { error = sessionError; }
        }
        if (error instanceof MattermostConnectionError && error.status === 401 && !renewed) {
          renewed = true;
          logger.warn('Mattermost 세션이 만료되어 한 번 다시 로그인합니다.');
          await client.logout().catch(() => {});
          const fresh = await client.login();
          if (!sameIdentity(identity, fresh)) {
            throw new MattermostConnectionError('재로그인한 계정 또는 DM이 변경되어 처리를 중단합니다.');
          }
          continue;
        }
        if (!(error instanceof MattermostConnectionError) || !error.retryable) throw error;
        const retryMs = Math.min((options.retryMs ?? 1_000) * 2 ** Math.min(retries++, 6), 30_000);
        logger.warn('Mattermost 연결 또는 발송 실패. 기록을 유지하고 잠시 후 재접속합니다.');
        await delay(retryMs, undefined, { signal }).catch(() => {});
      } finally {
        connection?.close();
        connection = undefined;
      }
    }
  } finally {
    connection?.close();
    try { await client.logout(); } catch {
      logger.warn('Mattermost 세션 로그아웃 실패. 활성 세션을 확인하세요.');
    }
  }
}

export async function checkMattermostWebSocket(config: MattermostConfig): Promise<void> {
  const client = new MattermostClient(config);
  const controller = new AbortController();
  let connection: LiveConnection | undefined;
  try {
    const identity = await client.login();
    connection = await LiveConnection.connect(
      client.websocketUrl, client.authenticationFrame(), identity, controller.signal,
    );
  } finally {
    connection?.close();
    await client.logout();
  }
}
