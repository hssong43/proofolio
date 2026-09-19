# Proofolio Web

Claude Design의 `Portfolio Verification Prototype.dc.html`을 Next.js(App Router) + TypeScript로 옮긴 프론트엔드 프로토타입이다.
현재는 분석·질문 데이터가 목데이터이며, 루트의 분석 코어(`src/pipeline.ts`)와는 아직 연결하지 않았다.

## 실행

```sh
cd web
npm install
npm run dev      # http://localhost:3000
npm run check    # tsc --noEmit
npm run build
```

쿼리 파라미터로 프로토타입 옵션을 바꿀 수 있다.

- `?seconds=60` 질문당 답변 시간(10~120초, 기본 40)
- `?fast=1` 분석 대기 시간을 짧게 (데모용)

## 구조

- `app/` 레이아웃, 페이지, 전역 스타일
- `components/VerificationFlow.tsx` 6단계 화면 상태 머신(useReducer)과 타이머
- `components/screens/` 직무 선택 → 업로드 → 분석 → 준비 → 질문 → 완료
- `components/Header.tsx`, `components/icons.tsx`
- `lib/data.ts` 직무별 목데이터, 상수, 유틸
