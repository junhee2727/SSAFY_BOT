import { ConfigurationError, loadConfig } from './config/config.ts';
import { checkMattermostConnection, MattermostConnectionError } from './mattermost/connection-check.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--check-config', '--check-mattermost'].includes(args[0]!))) {
    console.error('사용법: npm run config:check, npm run mattermost:check 또는 npm start');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  for (const warning of config.warnings) console.warn(warning);
  console.info(`설정 검증 완료 · 시간대: ${config.timezone}`);
  console.info(`뉴스레터 설정: ${config.newsletter.enabled ? '활성' : '비활성'} · GMS 설정: ${config.gms.enabled ? '활성' : '비활성'}`);

  if (args[0] === '--check-config') {
    console.info('설정 형식만 확인했습니다. 외부 인증이나 연결은 확인하지 않았습니다.');
    return;
  }
  if (args[0] === '--check-mattermost') {
    await checkMattermostConnection(config.mattermost);
    console.info('로그인 및 나와의 대화 연결 확인 완료. 검사 세션을 로그아웃했습니다.');
    console.info('메시지는 보내지 않았습니다. 실시간 명령 처리는 후속 구현입니다.');
    return;
  }
  const { createApplication } = await import('./runtime/application.ts');
  const app = createApplication(config);
  try {
    console.info('SQLite 초기화 완료.');
    console.info('실행 기반 준비 완료. DM·할 일·뉴스레터 처리 모듈은 아직 연결되지 않아 초기화 후 종료합니다.');
  } finally {
    app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError || error instanceof MattermostConnectionError
    ? error.message
    : '초기화 실패. Node.js 버전과 데이터베이스 경로·권한을 확인하세요.');
  process.exitCode = 1;
});
