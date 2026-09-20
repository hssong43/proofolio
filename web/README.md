# proofolio UI

머지된 PR #1의 Next.js 화면을 현재 TypeScript/OpenRouter 코어에 연결한다.
Gemini 직접 API 및 GCP/ADC 경로는 사용하지 않는다.

## 화면 구성

| 경로 | 대상 | 설명 |
|---|---|---|
| `/login` | 채용 담당자 | 이메일+비밀번호 로그인, 회원가입 탭(이메일·비밀번호·이름·회사). 계정은 저장소 JSON, 비밀번호는 scrypt 해시. |
| `/` | 채용 담당자 | 대시보드. 제목·직무·통과 점수·기간을 정해 테스트를 열면 6자리 코드가 발급된다. 목록에 제출 수와 통과 수가 보인다. |
| `/tests/[testId]` | 채용 담당자 | 응시자 목록(점수·통과/미통과). `/tests/[testId]/submissions/[id]`에서 종합 점수, 질문별 점수와 AI 코멘트, 답변을 본다. |
| `/test` | 응시자 | 코드 입력 → 이름·생년월일·전화번호 → **직무 확인**(담당자가 정한 직무가 맞는지만 확인, 아니면 담당자에게 연락 안내) → 업로드 → 분석 → 질문 10개 → 완료. 로그인 불필요. |
| `/demo` | 개발 | 이전 단일 흐름(직무 선택 포함). `?demo=1&fast=1`로 목데이터 시연, 없으면 실제 분석 API 사용. |

**mock 단계**: 테스트의 `mode`는 `demo`로 고정되어 분석은 직무별 목데이터(10문항)를 쓴다. 답변 평가도 `lib/server/evaluate.ts`의 **규칙 기반 mock**(`method: "mock-rules"`)이다. 답변 길이와 수치·판단 기준·결과·대안·직접 수행 신호로 0~100점을 매기고 코멘트를 만든다. 종합 점수(평균)가 테스트의 통과 점수(기본 70) 이상이면 통과다. LLM 평가로 바꿀 때는 `evaluateSubmission`의 시그니처만 유지하면 된다.

저장은 `output/web/store/`(또는 `PROOFOLIO_STORE_DIR`)의 JSON 파일이다.

```
store/accounts/<accountId>.json       담당자 계정(scrypt 해시)
store/account-emails/<sha256>.json    이메일 → accountId (wx 생성으로 중복 가입 차단)
store/session-secret                  세션 서명 비밀(PROOFOLIO_SESSION_SECRET이 없을 때 자동 생성)
store/tests/<testId>.json             테스트(직무, 코드, 기간, 통과 점수, 모드)
store/codes/<CODE>.json               코드 → testId (wx 생성으로 유일성 보장)
store/submissions/<testId>/<id>.json  응시자 정보, 본 질문 스냅샷, 답변, 소요 시간, 평가
```

담당자 세션은 계정 ID를 담은 HMAC 토큰의 httpOnly 쿠키(12시간)다. 응시자는 참여 시 발급되는 쿠키로만 자기 제출에 답변을 저장할 수 있고, 직무는 테스트에 고정된 값을 서버가 쓴다.
로그인·저장소 모두 로컬 MVP 수준이며 인터넷 공개용이 아니다.

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

Playwright는 프로덕션 빌드 후 `127.0.0.1:3101`에 전용 서버를 띄운다. 기존 개발/미리보기 서버는 먼저 중지한다.
데스크톱/모바일 두 직군 흐름과 실제 API의 PDF/예산/Origin 차단을 검사한다. 서버의 키는 빈 값, 예산은 0이며 기존 서버를 재사용하지 않는다.
분석/답변의 정상 API 응답은 stub이므로 실제 모델 품질이나 디스크 저장 검증으로 집계하지 않는다.
스크린샷과 실패 trace는 OS 임시 폴더의 `proofolio-playwright-results/`에 저장한다.

개발 파일 감시 한도 `EMFILE`은 `WATCHPACK_POLLING=1000 npm run dev` 또는 빌드 후 실행으로 피할 수 있다.

- 키: `OPENROUTER_API_KEY`. 루트 `.env.openrouter`도 호환 지원한다.
- 비용: `PROOFOLIO_MAX_COST_USD=0`이면 유료 분석은 시작되지 않는다. 승인한 누적 한도를 명시해야 한다.
- CLI·웹·벤치마크 공유 원장: `output/openrouter-budget.jsonl`. 새 웹 전용 원장으로 예산을 초기화하지 않는다.
- 모델·검증 방식·최신 유료 검증 결과는 [루트 README](../README.md)를 따른다.

## 화면과 제한

직무 선택 → PDF 업로드 → 진행 상태 조회 → 준비 → 질문 답변 → 완료.

- `?questions=1..10`: 최대 질문 수. 기본 10개, 근거가 부족하면 더 적다.
- `?seconds=10..120`: 질문당 시간, 기본 40초.
- `?demo=1&fast=1`: 목데이터 화면 시연. 실제 PDF 분석이나 품질 검증이 아니다.
- 디자인·마케팅 PDF만 실제 분석한다. 개발자·링크 분석은 미지원.
- 질문의 인용문/줄바꿈/원본 페이지는 코어 결과에서 보존한다.
- 답변은 `output/web/runs/<runId>/answers.json`에 로컬 저장만 한다. 기업 전송·평가 없음.
- 로컬 단일 프로세스 MVP다. 인증·영속 작업 큐가 없으므로 인터넷 공개/서버리스 배포용으로 사용하지 않는다.

## 구현

- `lib/server/runner.ts`: OpenRouter CLI 실행·진행 상태·화면용 결과 변환.
- `app/api/analyze/`: 업로드·상태 조회·답변 저장. 잘못된 PDF/직무/문항 수를 거부한다.
- `components/VerificationFlow.tsx`: 폴링·답변 타이머·화면 이동.
- `lib/data.ts`: 직무 매핑·명시적 데모 모드 목데이터.
