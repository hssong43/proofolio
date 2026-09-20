"use client";

import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { CloseIcon, FileIcon, UploadIcon } from "../icons";

export type UploadTab = "pdf" | "link";
export type UploadedFile = { name: string; size: string; file: File | null };

type Props = {
  roleLabel: string;
  demo: boolean;
  coding?: boolean;
  tab: UploadTab;
  file: UploadedFile | null;
  link: string;
  canAnalyze: boolean;
  submitting: boolean;
  error: string | null;
  onTabChange: (tab: UploadTab) => void;
  onFile: (file: File | undefined) => void;
  onRemoveFile: () => void;
  onLinkChange: (link: string) => void;
  onAnalyze: () => void;
};

export function UploadScreen({ roleLabel, demo, coding=false, tab, file, link, canAnalyze, submitting, error, onTabChange, onFile, onRemoveFile, onLinkChange, onAnalyze }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = () => fileRef.current?.click();
  const onDropKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    onFile(e.dataTransfer.files[0]);
  };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    onFile(e.target.files?.[0]);
    e.target.value = "";
  };

  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">{coding ? '공개 GitHub 저장소를 연결해주세요' : '포트폴리오를 올려주세요'}</h2>
        <p className="screen-subtitle">{roleLabel} 직무에 맞춰 핵심 내용을 찾아드릴게요</p>
      </div>
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
        {!coding && <div
          role="tablist"
          style={{ display: "inline-grid", gridTemplateColumns: "1fr 1fr", width: 280, height: 40, padding: 4, background: "#F4F4F5", borderRadius: 8 }}
        >
          <button type="button" role="tab" aria-selected={tab === "pdf"} className="tab-btn focus-ring" data-active={tab === "pdf"} onClick={() => onTabChange("pdf")}>
            PDF 업로드
          </button>
          <button type="button" role="tab" aria-selected={tab === "link"} className="tab-btn focus-ring" data-active={tab === "link"} onClick={() => onTabChange("link")}>
            링크 입력
          </button>
        </div>}

        {!coding && tab === "pdf" && !file && (
          <>
            <div
              role="button"
              tabIndex={0}
              className="dropzone focus-ring"
              data-dragging={dragging}
              onClick={pick}
              onKeyDown={onDropKey}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <UploadIcon />
              <div style={{ fontSize: 16, fontWeight: 500, color: "#18181B" }}>PDF를 끌어다 놓거나 클릭해서 업로드</div>
              <div style={{ fontSize: 13 }}>최대 50MB · PDF만 가능해요</div>
            </div>
            <input ref={fileRef} type="file" accept="application/pdf" onChange={onChange} style={{ display: "none" }} />
          </>
        )}

        {!coding && tab === "pdf" && file && (
          <div
            style={{ height: 64, border: "1px solid #E4E4E7", borderRadius: 8, padding: "0 16px", display: "flex", alignItems: "center", gap: 12, animation: "fadeIn .2s ease-out" }}
          >
            <FileIcon />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
              <span style={{ fontSize: 12, color: "#71717A" }}>{file.size}</span>
            </div>
            <button type="button" className="icon-btn focus-ring" aria-label="파일 제거" onClick={onRemoveFile} disabled={submitting}>
              <CloseIcon />
            </button>
          </div>
        )}

        {(coding || tab === "link") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              className="text-input focus-ring"
              value={link}
              onChange={(e) => onLinkChange(e.target.value)}
              placeholder={coding ? 'https://github.com/소유자/저장소' : 'https://'}
              inputMode="url"
              aria-label="포트폴리오 링크"
            />
            <div style={{ fontSize: 13, color: "#71717A" }}>
              {coding ? 'README와 소스 최대 8개를 읽어요.' : '링크 분석은 준비 중이에요. 지금은 PDF 업로드만 분석할 수 있어요.'}
            </div>
          </div>
        )}

        {error && <div className="error-box" role="alert">{error}</div>}
        <p className="screen-subtitle">예상 약 8분</p>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn-primary focus-ring" disabled={!canAnalyze || submitting} onClick={onAnalyze}>
            {submitting ? "업로드 중..." : "AI 분석 시작"}
          </button>
        </div>
      </div>
    </div>
  );
}
