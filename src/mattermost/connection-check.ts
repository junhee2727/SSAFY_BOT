import type { MattermostConfig } from '../config/config.ts';
import { MattermostClient, MattermostConnectionError } from './client.ts';
import type { HttpFetch, Identity } from './client.ts';

export { MattermostConnectionError } from './client.ts';
export type { HttpFetch } from './client.ts';

// Opens/gets a self DM without posting; the temporary session is never stored.
export async function checkMattermostConnection(
  config: MattermostConfig,
  fetcher: HttpFetch = fetch,
): Promise<Identity> {
  const client = new MattermostClient(config, fetcher);
  let completed = false;
  try {
    const identity = await client.login();
    completed = true;
    return identity;
  } finally {
    try {
      await client.logout();
    } catch {
      if (completed) {
        throw new MattermostConnectionError('DM 연결은 확인했지만 검사 세션 로그아웃에 실패했습니다. Mattermost의 활성 세션을 확인하세요.');
      }
    }
  }
}
