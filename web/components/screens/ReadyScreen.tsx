import { InfoIcon } from "../icons";

type Props = { totalSeconds: number; questionCount: number; storageError?: string; demo?: boolean; onStart: () => void };

export function ReadyScreen({ totalSeconds, questionCount, storageError, demo=false, onStart }: Props) {
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">질문 {questionCount}개, 각 {totalSeconds}초예요</h2>
        <p className="screen-subtitle">답변은 한 번만 가능하고, 시간이 끝나면 자동 제출돼요</p>
      </div>
      <p style={{ margin: 0, color: "#71717A", fontSize: 14 }}>총 답변 시간 최대 {Math.ceil(questionCount * totalSeconds / 60)}분 · 생성된 {questionCount}개만 진행해요</p>
      {storageError && <div role="status" className="error-box">{storageError}</div>}
      {demo && <p role="status">기존 생성 결과 {questionCount}개를 체험해요. 답변은 서버에 저장하지 않아요.</p>}
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
