# Proofolio Web

Claude Design의 `Portfolio Verification Prototype.dc.html`을 Next.js(App Router) + TypeScript로 옮긴 프론트엔드다.
루트의 분석 코어(`src/cli.ts`)를 자식 프로세스로 실행해 실제 PDF 분석 결과로 질문을 만든다.

## 실행

```sh
# 루트에서 코어 의존성 설치
npm ci

# 웹
cd web
npm install
npm run dev      # http://localhost:3000
npm run check    # tsc --noEmit
npm run build
```

실제 분석에는 루트 `.env`에 `GEMINI_API_KEY`가 필요하다. 키가 없으면 분석 화면에서 안내 문구와 함께 실패로 끝난다.
비용 원장은 기본 `output/web/api-budget.jsonl`이며 `PROOFOLIO_BUDGET_LEDGER` 환경변수로 바꿀 수 있다. 원장은 한 번에 하나의 분석만 허용한다.

쿼리 파라미터:

- `?questions=10` 요청할 최대 질문 수(1~20, 기본 10). 실제 질문 수는 분석 결과에 따라 이보다 적을 수 있다.
- `?seconds=60` 질문당 답변 시간(10~120초, 기본 40)
- `?demo=1` 분석 코어 대신 목데이터로 흐름만 시연
- `?fast=1` 데모 모드의 분석 대기 단축

## 구조

- `app/api/analyze` PDF 업로드 → 코어 CLI 실행 시작, `[runId]` 상태 조회, `[runId]/answers` 답변 저장
- `lib/server/runner.ts` CLI 실행, `output/web/runs/<runId>/`에 PDF·이벤트·결과·답변 보관, 결과를 화면용 형태로 변환
- `lib/client.ts` 브라우저 → API 호출
- `components/VerificationFlow.tsx` 6단계 화면 상태 머신, 상태 폴링, 타이머
- `components/screens/` 직무 선택 → 업로드 → 분석 → 준비 → 질문 → 완료
- `lib/data.ts` 직무↔track 매핑, 데모 목데이터, 상수

## 현재 제한

- 코어가 디자인·마케팅만 지원하므로 개발자 직무는 "준비 중"으로 비활성화된다.
- 링크 입력은 데모 모드에서만 동작한다. 실제 분석은 PDF 업로드만 지원한다.
- 답변은 `answers.json`으로 저장만 하며 평가하지 않는다.
