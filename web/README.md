# proofolio UI

PR #1의 기본 분석 화면과 PR #2의 채용 대시보드·응시 화면을 현재 TypeScript/OpenRouter 코어에 연결한다.
Gemini 직접 API 및 GCP/ADC 경로는 사용하지 않는다.

## 실행

루트에서 `npm ci`, `npm ci --prefix web` 후 [.env.example](../.env.example)을 참고해 루트 `.env`를 설정한다.

```sh
npm run dev                     # 루트에서 실행, http://127.0.0.1:3000
npm run check:web
npm run build:web
npm --prefix web run start
npm --prefix web exec -- playwright install chromium  # 최초 브라우저 설치
npm run test:e2e                 # 루트에서 실행, 합성 데이터 UI 검사
```

Playwright는 `.next-e2e`에 빌드한 후 `127.0.0.1:3101`에 전용 서버를 띄운다. `.next` 미리보기와 빌드 경로가 다르다. 무료·유료 E2E는 동시에 실행하지 않는다.
데스크톱/모바일 32개 검사로 기존 22개 회귀와 새 대시보드·응시 연결을 검사한다. 문항별 ACK, 초안 복구, 제출 확인 실패/재시도, 실제 개수 표시를 포함한다. 키는 빈 값, 예산은 0이며 기존 서버를 재사용하지 않는다.
분석/답변/채용 데이터의 정상 API 응답은 stub이므로 실제 모델 품질이나 Supabase 저장 검증으로 집계하지 않는다. 별도 실제 Supabase 왕복은 아래에 구분했다.
스크린샷과 실패 trace는 OS 임시 폴더의 `proofolio-playwright-results/`에 저장한다.

개발 파일 감시 한도 `EMFILE`은 `WATCHPACK_POLLING=1000 npm run dev` 또는 빌드 후 실행으로 피할 수 있다.

- 키: `OPENROUTER_API_KEY`. 루트 `.env.openrouter`도 호환 지원한다.
- 비용: `PROOFOLIO_MAX_COST_USD=0`이면 유료 분석은 시작되지 않는다. 승인한 누적 한도를 명시해야 한다.
- CLI·웹·벤치마크 공유 원장: `output/openrouter-budget.jsonl`. 새 웹 전용 원장으로 예산을 초기화하지 않는다.
- 모델·검증 방식·최신 유료 검증 결과는 [루트 README](../README.md)를 따른다.

## Vercel Git 자동 빌드

Vercel 프로젝트의 Root Directory는 `web`, 루트 바깥 소스 포함 옵션은 켠 상태로 유지한다.
`web/vercel.json`이 설치 명령을 `npm ci --prefix .. && npm ci`로 지정하므로,
루트 분석 코어와 웹의 두 lockfile을 모두 설치한 뒤 `npm run build`를 실행한다.
`web/package.json`에서도 Node.js 24를 지정한다. 웹 패키지만 설치하면 상위 `src/`의
`zod`, `pdf-lib`, `@napi-rs/canvas`, `pdfjs-dist`를 찾지 못해 빌드가 실패한다.

이 설정은 **빌드 의존성 누락 수정**이다. 현재 분석 실행은 로컬 자식 프로세스·영속 디스크·비용 원장에
의존하므로, Vercel에서 실제 PDF 분석까지 운영하려면 별도 실행 구조가 필요하다.
빌드 통과를 유료 분석·메일·DB 연동의 배포 검증 완료로 해석하지 않는다.

## 화면과 제한

회원: 이메일 로그인 → 직무 선택 → PDF/공개 GitHub 입력 → 분석 → 실제 생성 수 확인 → 문항별 답변 저장 → 내 기록.
비회원: 직무 선택 → Supabase에 보관된 기존 예제 읽기 → 저장 없는 답변 체험.

- `?questions=6..10`: 요청할 최대 질문 수. 기본 10개. 화면·진행 분모·완료 통계는 실제 `questions.length`를 사용하며 부족분을 채우지 않는다.
- `?seconds=10..120`: 질문당 시간, 기본 40초.
- `?demo=1`: 기존 DB 예제(디자인 7·마케팅 9·코딩 7)를 그대로 표시한다. 새 모델 호출·업로드·답변 DB 저장이 없다. 제3자 원본 PDF/이미지는 공개하지 않는다. 예전 목데이터는 제거했다.
- 디자인·마케팅은 PDF, 개발자는 공개 `https://github.com/owner/repo`만 지원한다. 코드는 읽기만 하며 실행/보안/의미 검수는 하지 않는다.
- 예상 시간은 약 8분으로 안내한다. 고정 SLA나 측정 결과가 아니다.
- 질문의 인용문/줄바꿈/원본 페이지는 코어 결과에서 보존한다.
- 회원 웹은 `PROOFOLIO_STORAGE=supabase`가 필요하다. 문항별 DB 저장 확인 전에는 다음 문항으로 넘어가지 않는다. 동일 전송은 허용하고 다른 답변으로 덮어쓰지는 않는다. [SQL·Auth·Storage](../supabase/README.md).
- 실패 답변은 그대로 두고 저장만 재시도한다. 저장된 답변은 DB, 미제출 초안/실패 payload는 동일 브라우저에서 최대 24시간 복구한다. 로그아웃 시 초안은 지운다.
- `?run=UUID` 및 내 기록으로 본인 실행을 다시 연다. 질문/답변 텍스트 내려받기와 실행 삭제를 제공한다. 다른 회원·비회원은 실행/답변/원문에 접근할 수 없다.
- 원문 PDF/선택 페이지/크롭/코드/결과는 비공개 Storage에 보관하고 소유자에게 60초 유효 링크만 발급한다.
- 이메일/비밀번호 로그인만 제공한다. **Google 제외. SMTP·실제 가입/재설정 메일 수신은 사용자 요청으로 보류**했다. 확인된 계정의 로그인은 실제 Supabase로 검증했다.
- 상시 실행 단일 Node·영속 디스크가 필요한 MVP다. 채용 담당자 화면은 아래에 추가했지만 플랫폼 전체 관리자, 배포 도메인/메일/운영 예산 설정은 별개다. 작업 큐 없이 서버리스/다중 인스턴스로 옮기지 않는다.

## 채용 화면

- `/`: 최신 main의 기본 분석·예제·계정·내 기록 그대로 유지.
- `/dashboard`: 로그인한 사용자가 자신의 테스트 생성(직무·기간·목표 6~10개), 코드 안내·현황 확인.
- `/test`: 동일 이메일 계정으로 코드 입력 → 정보·공유 동의 → 직무 확인 → 기존 분석/문항별 답변 저장 → 제출 확인.
- `/tests/:id`, `/tests/:id/submissions/:id`: 테스트 소유자만 응시 정보와 서버에 실제 저장된 질문·답변 조회. 전체 회원 조회 권한이 아니다.
- `/login?next=...`는 기존 이메일 창으로 연결하고 안전한 내부 경로로 복귀. `/demo`는 `/?demo=1`로 연결한다.
- PR의 목계정·JSON 파일·가짜 AI 점수는 사용하지 않는다. 질문은 브라우저가 보낸 스냅샷이 아니라 연결된 실행의 결과이며, 완료는 실제 답변 개수로 검사한다.
- 새로고침 시 `/test?submission=UUID`로 복구한다. 저장 실패는 문항만, 제출 확인 실패는 완료 요청만 재시도하며 유료 분석은 다시 시작하지 않는다.
- 담당자 삭제는 해당 테스트/응시 정보만 제거한다. 응시자 본인의 분석 기록은 유지한다. 원본 파일은 담당자에게 공유하지 않는다.
- SQL `202609200003_recruiting.sql`이 필요하다. 새 설정 키·별도 로그인·의존성은 추가하지 않았다. 서버리스에서 긴 분석 실행이 안 되는 기존 제약은 그대로다.

실제 Supabase 합성 QA: 임시 확인 계정 2개의 이메일 로그인, 테스트 생성, 타인 조회/제출 차단, 참여 동의와 동일 참여 재전송,
목표 10개 중 생성 6개 답변 완료, 답변 변경 거부, 담당자 조회·원본 링크 비노출을 확인했다. 임시 Auth/테스트/실행/답변은 정리했다.
기존 정책상 Auth 연결이 해제된 익명 해시 프로필 2행은 남는다. 이 검사는 DB/Auth 서버 함수 왕복이며 **브라우저+실제 모델 전체 왕복 검증은 아니다**.

## 구현

- `lib/server/runner.ts`: OpenRouter CLI 실행·진행 상태·화면용 결과 변환.
- `lib/server/database.ts`, `auth.ts`: 서버 전용 RPC·검증된 Auth 세션. DB는 fetch, Auth는 Supabase SSR SDK를 사용한다.
- `lib/server/assets.ts`, `retention.ts`: 비공개 파일·만료 정리. 만료 실행만 파일부터 지우며 예제는 보호한다.
- `app/api/analyze/`, `api/runs`, `api/examples`: 회원 입력/상태/문항 저장·내 기록·공개 예제.
- `components/AccountApp.tsx`, `VerificationFlow.tsx`, `SourcePreview.tsx`: 이메일 화면·기록·답변 복구·원문 미리보기.
- `lib/data.ts`: 직무 매핑과 화면 형식. 질문 목데이터 없음.

2026-09-20 실제 Supabase 합성 QA에서 이메일 로그인→개인 원문→답변 저장/동일 재시도→새로고침 복구→내 기록→로그아웃을 확인했다. 별도 계정의 접근을 막고 비회원은 마케팅 9개 예제를 읽었다. 새 PDF 모델 호출은 없으며 실제 메일 수신은 검증하지 않았다.
