"use client";

import { useState } from 'react';
import type { ExampleImage } from '@/lib/types';

export function PortfolioImages({ images, label, thumbnails = false }: { images: ExampleImage[]; label: string; thumbnails?: boolean }) {
  if (!images.length) return <p className="screen-subtitle">연결된 원본 이미지가 없어요.</p>;
  return <div className={thumbnails ? 'question-thumbnails' : 'question-originals'} role="group" aria-label="질문에 연결된 포트폴리오 페이지">
    {images.map(image => <PortfolioImage key={image.url} image={image} label={label} thumbnail={thumbnails} />)}
  </div>;
}

function PortfolioImage({ image, label, thumbnail }: { image: ExampleImage; label: string; thumbnail: boolean }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const url = `${image.url}${image.url.includes('?') ? '&' : '?'}retry=${attempt}`;
  return <div className={`card ${thumbnail ? 'portfolio-thumbnail' : 'portfolio-original'}`}>
    {failed ? <div className="empty-state"><p role="alert">이미지를 불러오지 못했어요.</p>
      <button className="btn-secondary" onClick={() => { setAttempt(n => n + 1); setFailed(false); }}>이미지 다시 불러오기</button></div> :
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${label} 포트폴리오 ${image.page}페이지 크게 보기`}>
        <img src={url} alt={`${label} 원본 포트폴리오 ${image.page}페이지`} loading={thumbnail ? 'lazy' : 'eager'} decoding="async" onError={() => setFailed(true)} />
        <span className="portfolio-image-caption"><strong>{image.page}페이지</strong><span>크게 보기 ↗</span></span>
      </a>}
  </div>;
}
