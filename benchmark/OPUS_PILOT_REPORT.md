# Gemini 비전 → GCP Opus 질문 생성: 두 문서 pilot

2026-09-19 18:12 KST 기준 **구현·오프라인 준비 완료, 실제 모델 비교는 할당량 때문에 미실행**이다. 무료 count-tokens 확인이 여전히 HTTP 429다. 새 유료 호출/포트폴리오 전송/추가 비용은 0이며 질문 품질 개선을 입증한 결과는 없다.

## 고정 범위

| 항목 | 설정 |
|---|---|
| 자료 | 기존 한국어 디자인 `d-shuu` 26쪽, 마케팅 `m-damyul` 43쪽 |
| 질문 비교 입력 | `mvp-23`의 같은 근거 JSON, 이미지 없음 |
| 비교 모델 | Gemini 3.1 Pro Preview / GCP global Claude Opus 5 |
| 새 전체 분석 | Flash 구조 스캔 → Pro 비전·추출·원본 대조 → Opus 질문 → Pro 영역·전제 검사 |
| 작성 설정 | MEDIUM, 최대 출력/추론 16,384토큰, JSON 형식 재시도 1회 |
| 분석 설정 | 기본 최대 5쪽·3개 포인트·2개 프로젝트, 기존 추출/질문 프롬프트 유지 |
| GCP 예산 | 승인된 총 $5, 모든 단계·재시도·반복이 같은 원장 사용 |
| Gemini 예산 | 기존 원장의 남은 $4.63207535만 사용, 추가 승인/초기화 없음 |

[고정 설정](opus-pilot-freeze.json)은 코어·재질문 도구·비교 보고 도구·코퍼스·gold·원본 결과 해시를 확인한다. 변경 시 기존 실행에 섞지 않고 새 설정/실행으로 분리한다. 두 자료는 이미 본 회귀 자료이며 새 holdout이나 분야별 10개 평가가 아니다. MEDIUM이라는 이름이 같아도 두 공급자의 연산량이 같다는 뜻은 아니다.

## 이번에 확인한 것

- `npm run check`, **99/99 테스트**, `git diff --check` 통과. 공통 실행/형식 재시도, JSON-only 경계, 예산 분리, 누락된 사용량, 실패 문서 보존을 검사했다.
- `opus-pilot-inputs-01`과 `opus-pilot-opus-inputs-01`의 첫 질문 요청 해시가 문서별로 같다. 시스템 지시·프롬프트·논리적 스키마·출력 한도가 같으며 공급자별 REST 포장은 구분한다.
- d-shuu는 질문 가능 근거 6개, m-damyul은 3개. 새 로컬 검사에서 추가 제외 0개. 이는 기존 비전 관찰이 모두 정확하다는 재인증이 아니다.
- 준비 실행 4건의 API 호출/원본 응답/이미지 전송은 모두 0. 결과 질문은 생성하지 않았다.
- Gemini 원장 SHA-256은 `806a45d36dcb8d74a62c0198c5c8bc36f9ce9b8b0dfaac8581887e9da42cdcab`로 불변이다. GCP 원장은 아직 만들지 않았고 활성 원장 잠금도 없다.

준비 산출물은 Git 제외 로컬 `output/benchmark/runs/opus-pilot-{inputs,opus-inputs}-01/<id>/`의 `source-manifest.json`, `first-writer-input.json`, `prepared.json`, `metrics.json`에 있다. 무료 실서버 점검/오프라인 검증 기록은 `output/benchmark/opus-pilot-preflight-01.json`에 보존했다.

## 남은 차단

무료 실서버 응답: `HTTP 429`, `global_online_prediction_requests_per_base_model`, `base_model=anthropic-count-tokens`. 기존 0 → 20회/분 신청 케이스는 `456aed18-1ba0-4d31-84b0-aabfa8b1cc74`다. 승인 상태는 [GCP 상향 요청 화면](https://console.cloud.google.com/iam-admin/quotas/qirs?project=supple-voyage-509107-q7)에서 확인한다.

count-tokens 통과도 실제 생성 접근을 보장하지 않는다. 생성 단계의 403/429, 미확인 비용, 예약 부족이 나오면 중단하고 실패/미실행 문서를 보존한다. 자동 증액·결제·리전 우회·모델 대체는 하지 않는다. 이번 $5는 로컬 실행의 추정 비용 상한이지 계정 전체 청구 상한이 아니다.

## 재개 명령

각 단계 결과를 확인한 후 다음 명령을 실행한다. 아래를 한꺼번에 실행하거나 실패한 디렉터리를 지워 재사용하지 않는다. 실행 ID가 이미 있으면 새 ID를 쓰되 **예산 원장/한도는 유지**한다.

### 0. 무료 연결 점검

```sh
npm run check:vertex -- --project supple-voyage-509107-q7
```

성공 전에는 유료 비교를 시작하지 않는다.

### 1. 같은 근거의 질문 단계 비교

먼저 Opus 생성 접근을 확인한다. 두 작성자는 이미 준비한 같은 입력과 해시가 일치해야 첫 생성 요청을 보낼 수 있다. 두 경로 모두 질문 작성 후 기존 로컬 검사와 Gemini 시각 검수를 거친다.

```sh
node benchmark/requestion.ts --from mvp-23 --run opus-pilot-claude-01 \
  --ids d-shuu,m-damyul --model gemini-3.1-pro-preview \
  --question-model claude-opus-5 --review-model gemini-3.1-pro-preview \
  --evidence-only --compare-to opus-pilot-inputs-01 \
  --freeze benchmark/opus-pilot-freeze.json \
  --gcp-project supple-voyage-509107-q7 --gcp-location global \
  --vertex-budget-ledger output/gcp-opus-budget.jsonl --vertex-max-cost-usd 5

node benchmark/requestion.ts --from mvp-23 --run opus-pilot-gemini-01 \
  --ids d-shuu,m-damyul --model gemini-3.1-pro-preview \
  --question-model gemini-3.1-pro-preview --review-model gemini-3.1-pro-preview \
  --evidence-only --compare-to opus-pilot-inputs-01 \
  --freeze benchmark/opus-pilot-freeze.json
```

처음 반환된 `raw-*-QuestionSet.json`을 재시도/수정 없이 따로 평가한다. 마지막 자동 질문 결과는 `result.json`/`questions.txt`로 별도 평가하며 첫 초안 성과와 섞지 않는다.

### 2. 새 PDF 전체 하이브리드 분석

앞 단계의 접근·비용·출처 오류를 검토한 뒤 같은 두 PDF를 처음부터 처리한다. 기존 근거 재사용 결과를 전체 분석 성공으로 세지 않는다.

```sh
npm run benchmark -- run --phase pilot --run opus-pilot-e2e-01 \
  --ids d-shuu,m-damyul --model gemini-3.1-pro-preview \
  --skim-model gemini-3.8-flash --review-model gemini-3.1-pro-preview \
  --question-model claude-opus-5 \
  --gcp-project supple-voyage-509107-q7 --gcp-location global \
  --vertex-budget-ledger output/gcp-opus-budget.jsonl --vertex-max-cost-usd 5 \
  --freeze benchmark/opus-pilot-freeze.json
```

### 3. 별도 원문 검수·보고·선택적 반복

검수자는 **Codex visual inspection; not a human expert**로 명시한다. 원본 PDF의 전체 관련 페이지와 최종 사용 영역을 시각적으로 대조하고 자동 모델 판정을 그대로 복사하지 않는다. 질문 문장은 수정하지 않는다.

- 첫 초안: 각 실행/문서의 `first-draft-audit.json`에 `reviewer`, 첫 raw 파일의 `raw_sha256`, `questions`를 기록한다. 질문 항목은 1부터 시작하는 `index`, `grounded`, `unsupported_premise`, `wrong_page_or_evidence`, `duplicate`, `note`를 갖는다. 미검수는 통과가 아니며 스키마/출력 잘림 실패는 그대로 남긴다.
- 최종 질문: `source-audit.json`은 기존 `Audit` 계약에 더해 `selected_points_complete`, `final_source_errors`, `substantive_questions`를 기록한다. 숫자·본인 역할·실험 전제·중복·핵심 포인트/필수 맥락·최종 사용 박스를 직접 확인한다. 전체 인벤토리의 박스 문제는 `bad_boxes`, 최종 사용 출처 문제는 `final_source_errors`로 구분한다.
- 문서별 통과: 근거 명확·비중복 질문 ≥3, 실질적인 설명 질문 ≥2, 잘못된 출처/전제 0, 선정 핵심/필수 맥락 검수 완료, 최종 사용 근거·박스 오류 0. 자동 `ready`만으로 통과시키지 않는다.

```sh
npm run benchmark -- report --run opus-pilot-claude-01
npm run benchmark -- report --run opus-pilot-gemini-01
npm run benchmark -- report --run opus-pilot-e2e-01
node benchmark/compare-report.ts --comparison opus-pilot-01 \
  --gemini-run opus-pilot-gemini-01 --claude-run opus-pilot-claude-01
```

보고서는 공급자별 입력·출력·추론·캐시·전체 토큰, 단계별 시간, 형식 재시도, 첫 초안/최종 통과 질문당 비용을 분리한다. Opus 출력은 추론 포함이며 분리 추론 토큰과 공급자 내부 재시도는 `null`/미확인이다. 응답 없는 유료 요청도 미정산이면 0토큰/$0으로 보고하지 않는다. 확인 가능한 사용량에 가격표를 적용한 API 추정 비용이며 실제 청구서는 아니다. 출처 검수 없는 질문의 통과당 비용도 미확인이다.

두 문서의 최종 품질이 통과하고 잔액으로 최대 비용을 예약할 수 있을 때만 단계 1의 Opus 명령을 새 실행 ID로 한 번 반복한다. 원래 `mvp-23` 근거/첫 입력은 그대로 고정한다. 질문의 변동은 평가할 수 있지만 **이 질문 단계 반복에서는 페이지를 다시 선정하지 않으므로 페이지 선정 재현성을 입증하지 않는다**. 부족하면 미실행으로 남긴다. 자동 모델 채택이나 20개 통과 주장은 하지 않는다.
