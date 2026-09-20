# Supabase 회원·질문·답변·파일 저장

2026-09-20 대상 프로젝트에 migration **001/002 적용**, 서버 연결 및 기존 예제 가져오기를 완료했다. 이메일·비밀번호 로그인만 사용한다. **Google 로그인과 관리자 화면은 제외**, 실제 메일 발송 설정/수신 확인은 사용자 요청으로 보류했다. 메일 확인을 끄지는 않았다.

## 새 환경 설정

1. SQL Editor에서 `migrations/202609200001_proofolio.sql`, `migrations/202609200002_member_flows.sql`을 순서대로 한 번씩 실행한다. 현재 프로젝트에는 이미 적용했으므로 반복할 필요가 없다. 기존 기록은 보존한다.
2. 루트 `.env`에 다음 값을 설정한다. OpenRouter 키/기존 비용 원장은 유지한다.

```dotenv
PROOFOLIO_STORAGE=supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PUBLISHABLE_KEY=
PROOFOLIO_APP_URL=http://127.0.0.1:3100
PROOFOLIO_MAX_COST_USD=0
```

Legacy `service_role` JWT만 있으면 `SUPABASE_SERVICE_ROLE_KEY`에 대신 넣는다. 서버 Auth는 publishable 키가 있으면 사용하고, 없으면 서버 전용 키를 서버 안에서만 사용한다. **브라우저 코드/`NEXT_PUBLIC_`에 secret·service 키를 넣지 않는다.**

3. Auth의 이메일·비밀번호 로그인을 사용한다. Auth URL Configuration의 Site URL을 앱 주소로 설정하고 아래 정확한 Redirect URL을 허용한다. 배포 후에는 실제 HTTPS 주소로 바꾸며 와일드카드로 대체하지 않는다.

```text
http://127.0.0.1:3100/auth/callback
http://127.0.0.1:3100/auth/callback?recovery=1
```

회원가입 확인·비밀번호 재설정은 PKCE callback을 사용한다. **실제 가입 메일 수신 및 링크 완료는 아직 미검증**이며 배포 전 SMTP/발신자·메일 전달을 확인해야 한다. 현재 QA는 Admin API로 이메일이 확인된 임시 계정을 만들어 로그인한 검사이지 신규 가입 메일 검사가 아니다. [공식 이메일 인증](https://supabase.com/docs/guides/auth/passwords) · [SMTP 설정](https://supabase.com/docs/guides/auth/auth-smtp) · [Redirect URL](https://supabase.com/docs/guides/auth/redirect-urls)

4. 서버를 재시작한다. `PROOFOLIO_MAX_COST_USD=0`은 예제/로그인/기존 답변을 허용하지만 새 유료 분석은 막는다. 실제 분석을 켜려면 승인된 기존 원장·한도를 별도로 결정한다. 키 잔액만으로 분석을 자동 활성화하지 않는다.

```sh
npm run build:web
PROOFOLIO_MAX_COST_USD=0 npm --prefix web run start -- --port 3100
```

## 저장 구조와 접근

`Supabase Auth → proofolio_users → proofolio_runs → proofolio_questions → proofolio_answers`

| 대상 | 저장/접근 계약 |
| --- | --- |
| Auth / users | Auth가 이메일·암호를 관리한다. 앱 users에는 Auth UUID와 해시 기반 내부 ID를 연결하며 암호를 복제하지 않는다. |
| runs | 소유자·직군·입력 해시·상태·원래 결과·실제 질문 수·토큰/시간/비용. 완료 결과는 불변. |
| questions | 실행별 질문 ID/순서/전체 카드/인용/원본 페이지/영역 연결. 목표 수를 채우려고 질문을 추가하지 않는다. |
| answers | 실행+질문 ID에 답변/소요 초 연결. 한 문항씩 원자 저장, 같은 재전송은 성공, 다른 내용으로 덮어쓰기 거부. |
| examples | design/marketing/coding 예제 카드와 한계 안내. 비회원에게 텍스트만 공개하며 답변은 저장하지 않는다. |
| Storage | `proofolio-private` 비공개 버킷. 소유자 해시/실행 UUID 아래 PDF·선택 페이지·질문 크롭·코드·원래 결과 JSON. |

- 모든 앱 테이블 RLS 활성화, anon/authenticated 직접 DB·뷰·RPC 접근 차단. Next 서버가 `getUser()`로 세션을 검증하고 소유권 확인 후 서버 키로 접근한다. 브라우저의 user ID를 신뢰하지 않는다.
- Auth 쿠키는 HttpOnly·SameSite=Lax이고 HTTPS 앱 주소에서는 Secure다. DB/원문 경로·내부 사용자 ID를 상태 응답에 노출하지 않는다.
- 원문 보기 API는 결과에 등록된 asset ID만 허용하고 소유자 전용 **60초 signed URL**을 발급한다. 예제 원본 PDF/이미지는 공개 데모로 재배포하지 않는다.
- 웹 질문 목표 6~10개, 기본 10개. 근거가 적으면 부족 경고와 실제 개수를 표시한다. 0개는 시작 불가다. 약 8분은 안내값이다.
- 서버 저장 확인 전에 다음 문항으로 넘어가지 않는다. 실패하면 답변·전송 payload를 유지해 **저장만** 재시도한다. 모델 호출은 재시작하지 않는다.
- 새로고침 시 DB에 확인된 답변을 복구한다. 미제출/응답 미확인 초안은 같은 브라우저에서 최대 24시간 보존하고 로그아웃 시 지운다. localStorage 사용 불가 시 초안 복구는 보장하지 않는다.
- 본인 실행 목록/질문·답변 TXT 내려받기/실행 삭제를 제공한다. 관리자 조회는 아래 별도 서버 권한 구현이 필요하다.

## 기존 예제 가져오기 — 모델 호출 없음

현재 DB에 **디자인 7개·마케팅 9개·코딩 7개**를 넣었다. 디자인/마케팅은 `gemini-broad-20260920-02`의 원래 자동 결과다. 사람이 골라 수정한 6/8개 결과로 바꾸지 않았고 `needs_review` 및 누락 경고도 유지한다.

```sh
npm run seed:examples -- \
  --coding-result output/coding/member-example-20260920/result-linked.json \
  --coding-input output/coding/member-example-20260920/input.json
```

스크립트는 해시를 확인하고 비공개 버킷을 준비한 뒤 기존 파일/결과를 가져온다. 같은 결과는 재사용하고 다른 결과/원문으로 덮어쓰지 않는다. 로컬 원본은 Git에 없으므로 새 체크아웃만으로 시딩할 수는 없다.

코딩 예제는 `hssong43/proofolio`의 커밋 `d892b889c5c1590bc3a2acd3673685410414ae2a`에 있는 파일 8개를 읽어 Gemini Flash **1회**로 만들었다. 원래 응답의 7문항 중 긴 원문 구절 5개가 임의 400자 제한에 걸렸고, 제한을 1,200자로 고친 뒤 **저장된 동일 응답을 무과금 재연결**했다. 질문을 고치거나 다시 생성하지 않았다. 원래 `result.json`/raw/원장은 보존하고 새 `result-linked.json`을 사용했다.

실제 비용 **$0.0461403**, 입력 **22,333** / 출력 **2,369** / 보고된 추론 **0** 토큰, **19.34초**, 호출 1회·앱 재시도 0회. 공급자 내부 재시도는 미확인. 경로와 원문 구절의 정확한 연결만 확인했고, 질문 의미·보안·코드 실행은 별도 검수하지 않았다.

## 제한·보관·삭제

- 실제 분석 전 DB 원자 잠금으로 **회원당 24시간 3회, 전체 동시 실행 1회**를 검사한다. 공유 서버 비용 원장의 총한도/예약/실제 정산은 별도로 유지한다. 재시작이 새 예산을 만들지 않는다.
- 일반 실행 보관은 30일, 회원 삭제는 즉시 숨기고 7일 후 정리 대상으로 만든다. 예제의 원본 실행은 보호한다.
- 상시 Node 서버 시작 및 이후 24시간마다 최대 20개 만료 실행을 처리한다. 소유자 경로 파일 삭제가 확인된 뒤 조건부 purge RPC와 해당 실행의 로컬 백업을 정리한다. 실패하면 남겨 다음 주기에 재시도한다. 로컬 벤치마크 원본·비용 원장은 지우지 않는다.
- **서버가 꺼져 있으면 정리도 멈춘다.** 현재는 단일 프로세스 MVP이며 독립 스케줄러·영속 작업 큐·다중 서버 잠금이 아니다. 분석 중 서버가 종료되면 실패로 표시할 수 있으나 모델을 자동 재실행하지 않는다.

## 검사와 관리자 연결

`tests/verify.sql`, `tests/verify_member_flows.sql`은 합성 데이터를 사용한 트랜잭션 검사 후 ROLLBACK한다. 로컬 PostgreSQL WASM에서 migration 001/002와 함께 통과했다. 실제 프로젝트에서도 테이블/RPC 노출·예제·비공개 파일·회원 세션을 확인했다.

실제 Supabase + Playwright(1440×1000, 390×844) 무과금 검사:

- 확인된 두 임시 계정의 이메일 로그인, 서로의 상태/답변/원문 접근 차단.
- 소유자 원문 보기, 답변 6개 저장·동일 재전송·다른 답변 거부, 새로고침 초안 복구, 내 기록·로그아웃.
- 비회원 마케팅 9문항 예제, 예산 0의 새 분석 차단, 페이지/콘솔 오류 없음.
- 임시 Auth 계정·합성 실행·파일 제거. 이메일을 담지 않는 해시 프로필은 Auth 연결이 해제된 채 남을 수 있다.
- **가입/재설정 메일 수신은 미검증. 새 유료 PDF 웹 실행도 하지 않았다.** 코딩의 1회 모델 호출과 구분한다.

관리자 UI는 아직 없으며 서버 관리자 인증/권한도 별도로 구현해야 한다. SQL Editor에서는 기존 읽기 뷰를 사용할 수 있다.

```sql
select * from public.proofolio_admin_runs order by started_at desc limit 100;
select * from public.proofolio_users order by created_at desc limit 100;
select * from public.proofolio_admin_answers
where run_id = '실제-실행-UUID'::uuid order by position;
```

남은 운영 작업은 관리자 권한/화면, 사용자가 보류한 메일 설정·수신 확인, 공개 HTTPS 배포·운영 예산 연결이다. 답변 평가·음성·Google 로그인·다중 서버는 이번 범위가 아니다.
