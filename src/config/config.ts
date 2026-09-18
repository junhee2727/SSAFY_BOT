import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface NewsletterConfig {
  enabled: true;
  email: string;
  password: string;
  mailbox: string;
  allowedSenders: string[];
  pollIntervalSeconds: number;
  deliveryTime: string;
}

export interface GmsConfig {
  enabled: true;
  apiKey: string;
  model: string;
  endpoint: string;
}

export interface MattermostConfig {
  url: string;
  loginId: string;
  password: string;
  mfaToken?: string;
}

export interface AppConfig {
  timezone: 'Asia/Seoul';
  databasePath: string;
  mattermost: MattermostConfig;
  newsletter: NewsletterConfig | { enabled: false };
  gms: GmsConfig | { enabled: false };
  warnings: string[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationError(`${label}: JSON 객체가 필요합니다.`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigurationError(`${label}: 비어 있지 않은 문자열이 필요합니다.`);
  }
  return value.trim();
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new ConfigurationError(`${name}: 필수 환경변수가 누락되었습니다.`);
  }
  return value;
}

function enabled(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${label}.enabled: true 또는 false가 필요합니다.`);
  }
  return value;
}

function httpUrl(value: unknown, label: string, httpsOnly = false): string {
  const raw = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`${label}: 올바른 URL이 필요합니다.`);
  }
  if (!(httpsOnly ? ['https:'] : ['https:', 'http:']).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigurationError(`${label}: 인증정보·쿼리·fragment 없는 ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} URL이 필요합니다.`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function email(value: unknown, label: string): string {
  const address = text(value, label);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new ConfigurationError(`${label}: 이메일 주소 형식이 필요합니다.`);
  }
  return address;
}

function mattermostConfig(env: NodeJS.ProcessEnv): MattermostConfig {
  const url = httpUrl(secret(env, 'MATTERMOST_URL'), 'MATTERMOST_URL', true);
  const mfaToken = env.MATTERMOST_MFA_TOKEN?.trim();
  if (mfaToken && !/^\d{6}$/.test(mfaToken)) {
    throw new ConfigurationError('MATTERMOST_MFA_TOKEN: 현재 6자리 인증 코드를 입력하세요.');
  }
  return {
    url,
    loginId: text(secret(env, 'MATTERMOST_LOGIN_ID'), 'MATTERMOST_LOGIN_ID'),
    password: secret(env, 'MATTERMOST_PASSWORD'),
    ...(mfaToken ? { mfaToken } : {}),
  };
}

function newsletterConfig(raw: unknown, env: NodeJS.ProcessEnv): AppConfig['newsletter'] {
  const config = object(raw, 'newsletter');
  if (!enabled(config.enabled, 'newsletter')) return { enabled: false };
  const mailbox = text(config.mailbox, 'newsletter.mailbox');
  if (!Array.isArray(config.allowedSenders)) {
    throw new ConfigurationError('newsletter.allowedSenders: 이메일 주소 배열이 필요합니다.');
  }
  const allowedSenders = [...new Set(config.allowedSenders.map(
    (sender) => email(sender, 'newsletter.allowedSenders'),
  ))];
  const interval = config.pollIntervalSeconds;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1) {
    throw new ConfigurationError('newsletter.pollIntervalSeconds: 양의 정수가 필요합니다.');
  }
  const deliveryTime = text(config.deliveryTime, 'newsletter.deliveryTime');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(deliveryTime)) {
    throw new ConfigurationError('newsletter.deliveryTime: HH:mm 형식의 시각이 필요합니다.');
  }
  return {
    enabled: true,
    email: email(secret(env, 'NAVER_EMAIL'), 'NAVER_EMAIL'),
    password: secret(env, 'NAVER_APP_PASSWORD'),
    mailbox, allowedSenders, pollIntervalSeconds: interval, deliveryTime,
  };
}

function gmsConfig(raw: unknown, env: NodeJS.ProcessEnv): AppConfig['gms'] {
  const config = object(raw, 'gms');
  if (!enabled(config.enabled, 'gms')) return { enabled: false };
  const model = text(config.model, 'gms.model');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
    throw new ConfigurationError('gms.model: 모델 이름 형식이 올바르지 않습니다.');
  }
  const baseUrl = httpUrl(config.baseUrl, 'gms.baseUrl', true);
  return {
    enabled: true,
    apiKey: secret(env, 'GMS_KEY'),
    model,
    endpoint: `${baseUrl}/models/${model}:generateContent`,
  };
}

function optionalFeature<T>(
  label: string,
  parse: () => T,
  warnings: string[],
): T | { enabled: false } {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    warnings.push(`${label} 비활성화: ${error.message}`);
    return { enabled: false };
  }
}

export function parseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AppConfig {
  const config = object(raw, '설정');
  if (config.timezone !== 'Asia/Seoul') {
    throw new ConfigurationError('timezone: Asia/Seoul을 사용해야 합니다.');
  }
  const database = object(config.database, 'database');
  const databasePath = text(database.path, 'database.path');
  if (databasePath === ':memory:' || databasePath.includes('\0')) {
    throw new ConfigurationError('database.path: 영구 저장할 로컬 파일 경로가 필요합니다.');
  }
  const mattermost = mattermostConfig(env);
  const warnings: string[] = [];
  const newsletter = optionalFeature('뉴스레터', () => newsletterConfig(config.newsletter, env), warnings);
  const gms = optionalFeature('GMS', () => gmsConfig(config.gms, env), warnings);
  if (newsletter.enabled && newsletter.allowedSenders.length === 0) {
    warnings.push('뉴스레터 발신자 목록이 비어 있어 메일을 수집하지 않습니다.');
  }
  return {
    timezone: 'Asia/Seoul',
    databasePath: resolve(cwd, databasePath),
    mattermost, newsletter, gms, warnings,
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const configPath = resolve(cwd, env.BOT_CONFIG_PATH?.trim() || 'config/settings.json');
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigurationError('설정 파일을 읽을 수 없습니다. BOT_CONFIG_PATH와 파일 권한을 확인하세요.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    // Do not expose JSON parser excerpts: configuration may contain private data.
    throw new ConfigurationError('설정 파일이 올바른 JSON 형식이 아닙니다.');
  }
  return parseConfig(raw, env, cwd);
}
