import { ConfigurationError, loadConfig } from './config/config.ts';
import { checkMattermostConnection, MattermostConnectionError } from './mattermost/connection-check.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && ![
    '--check-config', '--check-mattermost', '--check-websocket', '--check-storage',
  ].includes(args[0]!))) {
    console.error('사용법: npm start 또는 npm run config:check / mattermost:check / mattermost:check-websocket / storage:check');
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
    console.info('연결 검사에서는 메시지를 보내지 않습니다. 명령 수신은 npm start로 실행하세요.');
    return;
  }
  const { runMattermost, checkMattermostWebSocket } = await import('./mattermost/service.ts');
  if (args[0] === '--check-websocket') {
    await checkMattermostWebSocket(config.mattermost);
    console.info('로그인 및 WebSocket 인증 확인 완료. 검사 연결과 세션을 종료했습니다.');
    return;
  }
  const { createApplication } = await import('./runtime/application.ts');
  const app = createApplication(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.info('SQLite 초기화 완료.');
    if (args[0] === '--check-storage') return;
    await runMattermost(config.mattermost, app.database, console, controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError || error instanceof MattermostConnectionError
    ? error.message
    : '초기화 실패. Node.js 버전과 데이터베이스 경로·권한을 확인하세요.');
  process.exitCode = 1;
});
