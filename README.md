# SSAFY Mattermost 개인 비서 봇

Mattermost DM으로 할 일을 관리하고 네이버 뉴스레터를 SSAFY GMS로 요약하는 개인용 봇입니다.

현재 구현 범위는 **설정 및 실행 기반과 Mattermost 로그인 연결 검사**입니다. 개인 아이디·비밀번호로 로그인해 ‘나와의 대화’를 확인합니다. 할 일 명령, 메일 수집, 요약 호출, 예약 발송은 후속 기능입니다. `start`는 초기화를 확인한 뒤 종료하며, 실제 로그인은 `mattermost:check`로 실행합니다.

## 준비 사항

- Node.js 24.x와 npm.
- Mattermost HTTPS 서버 주소와 본인 로그인 아이디·비밀번호.
- 메일 기능을 연결할 때 네이버 IMAP 활성화와 인증정보.
- 요약 기능을 연결할 때 SSAFY GMS API 키.

자동 테스트에는 실제 외부 서비스 접속이 필요하지 않습니다. 실제 계정 연결은 아래 연결 검사 명령으로 별도 확인합니다.

## 설치와 실행

저장소 루트에서 실행합니다. PowerShell 실행 정책으로 `npm.ps1`이 차단되면 아래처럼 `npm.cmd`를 사용하세요. 다른 셸에서는 `npm`으로 실행할 수 있습니다.

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

이미 `.env`가 있다면 복사하지 말고 기존 파일을 수정하세요. 필수값을 입력합니다.

```dotenv
MATTERMOST_URL=https://your-mattermost-server.example
MATTERMOST_LOGIN_ID=your-login-id
MATTERMOST_PASSWORD="your-password"
```

위 값은 예시이며 실제 값을 커밋하거나 채팅에 공유하지 않습니다. 비밀번호에 `#` 또는 앞뒤 공백이 있으면 따옴표로 감싸세요. `.env`와 기존 프로세스 환경변수에는 위 세 값을 설정합니다. 서버에서 추가 인증을 요구하면 선택 항목 `MATTERMOST_MFA_TOKEN`에 현재 6자리 코드를 입력하고 검사 후 지우세요.

```powershell
npm.cmd run config:check
npm.cmd run mattermost:check
npm.cmd run build
npm.cmd start
```

`config:check`는 설정만 검사하고 DB를 만들지 않습니다. `start`는 검증 후 `data/bot.sqlite`를 만들고 연결을 닫습니다. 필수 설정 누락·잘못된 JSON·DB 초기화 실패 시 종료 코드는 1입니다.

`mattermost:check`는 서버에 로그인하고 본인 ID로 ‘나와의 대화’를 조회하거나 생성합니다. 메시지는 발송하지 않습니다. 검사 세션은 메모리에만 보관하고 종료 시 로그아웃합니다. 로그인·연결·로그아웃 실패 시 종료 코드는 1이며 인증 오류를 자동 반복하지 않습니다. 일반 `start`나 `dev`는 로그인하지 않습니다.

로그인 성공 후에도 DM 권한이나 서버 정책에 따라 검사가 실패할 수 있습니다. 세션 로그아웃 실패 안내가 나오면 Mattermost의 활성 세션에서 검사 세션을 확인하세요. 아이디·비밀번호 인증만 지원하며 사용자 ID는 서버 로그인 응답에서 가져옵니다.

## 개발 및 검증 명령

| 명령 | 역할 |
| --- | --- |
| `npm.cmd run dev` | TypeScript 진입점 실행, 파일 변경 시 다시 실행; Ctrl+C로 감시 종료 |
| `npm.cmd run config:check` | 비밀값을 출력하지 않고 설정 검사 |
| `npm.cmd run mattermost:check` | 실제 로그인 → 나와의 대화 조회/생성 → 검사 세션 로그아웃 |
| `npm.cmd run typecheck` | 소스와 테스트의 엄격한 타입 검사 |
| `npm.cmd run build` | `src/`를 `dist/`로 컴파일 |
| `npm.cmd start` | 빌드한 진입점 실행 |
| `npm.cmd test` | Node.js 내장 테스트 러너로 외부 서비스 없이 검증 |

Node.js의 TypeScript 실행은 타입 검사와 별개이므로 `typecheck`와 `build`를 함께 실행하세요. 별도 포매터·린터는 아직 도입하지 않았습니다. Node 버전에 따라 내장 SQLite 실험 기능 안내가 표시될 수 있습니다.

## 설정

비밀값은 `.env`, 일반 설정은 `config/settings.json`에서 관리합니다. Node.js가 `.env`를 읽으며 이미 지정한 프로세스 환경변수가 우선합니다. `BOT_CONFIG_PATH`로 다른 JSON 파일을 선택할 수 있습니다. 설정 파일 경로와 DB 상대 경로는 모두 명령을 실행한 디렉터리 기준입니다.

개인 발신자 목록을 커밋하지 않으려면 `config/settings.local.json`에 설정을 복사하고 `.env`에 `BOT_CONFIG_PATH=config/settings.local.json`을 지정하세요.

| 설정 | 기본값 / 동작 |
| --- | --- |
| `timezone` | `Asia/Seoul` 고정 |
| `database.path` | `data/bot.sqlite` |
| `newsletter.enabled` | `false`; 메일 설정은 선택 사항 |
| `newsletter.mailbox` | `INBOX` |
| `newsletter.allowedSenders` | 빈 배열; 등록 전 수집하지 않음 |
| `newsletter.pollIntervalSeconds` | `300` |
| `newsletter.deliveryTime` | `09:00`, 24시간제 `HH:mm` |
| `gms.enabled` | `false`; 요약 설정은 선택 사항 |
| `gms.model` | `gemini-3.5-flash` |
| `gms.baseUrl` | 사용자 제공 GMS의 Gemini `v1beta` 주소 |

메일 설정을 활성화하면 `NAVER_EMAIL`과 `NAVER_APP_PASSWORD`가 필요합니다. GMS 설정을 활성화하면 `GMS_KEY`가 필요합니다. GMS 요청 주소는 `{baseUrl}/models/{model}:generateContent`로 구성합니다. 활성화는 설정을 준비하는 것이며, 아직 외부 서비스 호출을 시작하지 않습니다.

선택 기능의 설정·인증정보가 잘못되면 경고 후 해당 기능만 비활성화하고 핵심 초기화를 계속합니다. 전체 설정 파일을 읽거나 파싱할 수 없으면 시작하지 않습니다.

## 구조와 기능 확장

- `src/config/`: 설정 파싱과 필수값 검증.
- `src/mattermost/`: 비밀번호 로그인과 나와의 대화 연결 검사.
- `src/storage/`: SQLite 연결, WAL·외래 키 설정. 업무 테이블과 마이그레이션은 저장·복구 기능에서 추가.
- `src/runtime/`: DB 수명 관리와 기능별 작업 실행·상태.
- `src/index.ts`: 설정 검사와 실행 진입점.
- `tests/`: 설정·CLI·DB 재시작·오류 격리 테스트.

후속 모듈은 `createApplication()`의 설정·DB·`features`를 사용합니다. 이벤트나 예약 작업은 `await features.run('mail', operation)`처럼 실행해야 작업 실패가 다른 기능으로 전파되지 않습니다. 같은 기능의 중첩 실행은 건너뛰며, 원본 예외·인증정보·메일 본문은 로그에 출력하지 않습니다. 작업 상태는 현재 프로세스에만 유지되며 영구 발송 기록은 후속 구현 범위입니다.

향후 DM 수신은 로그인한 사용자의 ‘나와의 대화’ 채널로 제한합니다. 사람이 쓴 명령과 프로그램 응답의 작성자가 같으므로, 프로그램이 저장한 발송 ID나 게시물 속성으로 응답을 제외해야 합니다. 작성자 ID만으로 자기 메시지를 모두 제외하면 사용자 명령도 처리되지 않습니다.

PC가 꺼져 있으면 작업할 수 없습니다. 재시작 후 누락 DM·알림 복구, 실제 할 일 및 뉴스레터 전체 연동 검증은 해당 기능 구현 시 수행합니다.

- [전체 계획](docs/plan.md)
- [설정 및 실행 명세](docs/feature/설정및실행.md)
- [Node.js 내장 테스트 러너](https://nodejs.org/docs/latest-v24.x/api/test.html)
- [Mattermost 로그인 API](https://github.com/mattermost/mattermost/blob/master/api/v4/source/users.yaml)
