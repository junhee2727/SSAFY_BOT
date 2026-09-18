import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export function settings() {
  return JSON.parse(readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));
}

export function environment(): NodeJS.ProcessEnv {
  return {
    MATTERMOST_URL: 'https://mattermost.example.test',
    MATTERMOST_LOGIN_ID: 'test-only-user',
    MATTERMOST_PASSWORD: 'test-only-password',
  };
}

export function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'ssafy-bot-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
