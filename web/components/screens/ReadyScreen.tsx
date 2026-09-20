import { InfoIcon } from "../icons";

type Props = { totalSeconds: number; questionCount: number; limitation: { requested: number; status: string; issues: string[]; storageError?: string; demo?: boolean; notice?: string } | null; onStart: () => void };
const issueLabels: Record<string, string> = {
  fewer_than_three_questions: "검증을 통과한 질문이 세 개 미만이에요.",
  selected_points_uncovered: "선정한 핵심 포인트 일부를 충분히 다루지 못했어요.",
  insufficient_substantive_questions: "구체적인 판단을 묻는 설명 질문이 부족해요.",
  repeated_ownership_questions: "참여 범위 확인 질문이 반복돼요.",
  coding_unreviewed: '코드 기반 질문은 별도 의미·보안 검수를 하지 않았어요.',
  fewer_than_six_questions: '근거가 충분한 질문이 여섯 개 미만이에요.',
  source_storage_incomplete: '원본은 보관했지만 일부 미리보기 저장을 완료하지 못했어요.',
};

export function ReadyScreen({ totalSeconds, questionCount, limitation, onStart }: Props) {
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">질문 {questionCount}개, 각 {totalSeconds}초예요</h2>
        <p className="screen-subtitle">답변은 한 번만 가능하고, 시간이 끝나면 자동 제출돼요</p>
      </div>
      <p style={{ margin: 0, color: "#71717A", fontSize: 14 }}>총 답변 시간 최대 {Math.ceil(questionCount * totalSeconds / 60)}분 · 생성된 {questionCount}개만 진행해요</p>
      {limitation?.storageError && <div role="status" className="error-box">{limitation.storageError}</div>}
      {limitation?.demo && <p role="status">기존 생성 결과 {questionCount}개를 체험해요. 답변은 서버에 저장하지 않아요. {limitation.notice}</p>}
      {limitation && (limitation.status === "needs_review" || questionCount < 6) && (
        <div role="status" className="card" style={{ padding: 20, borderColor: "#D97706", lineHeight: 1.6 }}>
          <strong>목표 6~{limitation.requested}개 / 생성 {questionCount}개 · {questionCount < 6 ? "부분 결과" : "검토 권장"}</strong>
          <p style={{ margin: "8px 0" }}>선택한 자료에 연결해 생성한 질문이에요. 포트폴리오 전체나 작성자의 진위를 검증한 결과는 아니에요.</p>
          {[...new Set(limitation.issues.map(issue => issueLabels[issue] ?? '추가 검토가 필요한 제한 사항이 있어요.'))].map(label => <div key={label}>{label}</div>)}
        </div>
      )}
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 32 }}>
        <div style={{ border: "1px solid #E4E4E7", borderRadius: 8, padding: "16px 20px", display: "flex", gap: 14, alignItems: "flex-start" }}>
          <InfoIcon style={{ flex: "none", marginTop: 2 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600 }}>시작 전에 확인해주세요</div>
            <div style={{ color: "#3F3F46", display: "flex", flexDirection: "column", gap: 2 }}>
              <span>· 조용한 환경에서 집중할 수 있을 때 시작해요</span>
              <span>· 인터넷 연결이 안정적인지 확인해주세요</span>
              <span>· 이전 질문으로 돌아갈 수 없어요</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: "#71717A" }}>질문 미리보기</div>
          <div aria-label={`생성된 질문 ${questionCount}개 미리보기`} style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {Array.from({ length: questionCount }, (_, i) => (
              <div
                key={i}
                style={{ width: 56, height: 56, borderRadius: "50%", border: "1px solid #D4D4D8", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 500, color: "#71717A" }}
              >
                Q{i + 1}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#71717A" }}>버튼을 누르면 바로 첫 질문이 시작돼요</span>
          <button type="button" className="btn-primary focus-ring" disabled={questionCount === 0} onClick={onStart}>
            준비 완료
          </button>
        </div>
      </div>
    </div>
  );
}
