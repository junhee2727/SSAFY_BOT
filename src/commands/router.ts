export type CommandHandler = (message: string, sourceId: string) => string | null;
export interface CommandHandlers {
  tasks?: CommandHandler;
  newsletter?: CommandHandler;
  status?: CommandHandler;
}

// Synchronous handlers run inside the transport's SQLite transaction. Future
// task mutations must use that same database, never detached network work.
export function createCommandRouter(handlers: CommandHandlers = {}): CommandHandler {
  return (message, sourceId) => {
    const command = message.trim();
    if (command === '도움말') {
      return [
        '사용 가능한 명령',
        '- 도움말: 명령 안내',
        '- 상태: 현재 연결 상태',
        '',
        '할 일 관리와 뉴스레터 조회는 아직 준비 중입니다.',
      ].join('\n');
    }
    if (command === '상태') {
      return handlers.status?.(command, sourceId)
        ?? 'Mattermost 연결 정상 · 나와의 대화에서 명령 수신 중\n할 일·메일 수집·요약·예약 발송: 아직 연결되지 않음';
    }
    if (/^할일(?:\s|$)/.test(command)) {
      return handlers.tasks?.(command, sourceId) ?? '할 일 관리 기능은 아직 구현되지 않았습니다.';
    }
    if (/^뉴스레터(?:\s|$)/.test(command)) {
      return handlers.newsletter?.(command, sourceId) ?? '뉴스레터 조회 기능은 아직 구현되지 않았습니다.';
    }
    if (/^(도움말|상태)(?:\s|$)/.test(command)) return '도움말 또는 상태를 단독으로 입력하세요.';
    return null;
  };
}
