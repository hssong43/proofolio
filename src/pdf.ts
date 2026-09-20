import {PDFDocument, ParseSpeeds} from 'pdf-lib';
import {createCanvas, DOMMatrix, ImageData, Path2D} from '@napi-rs/canvas';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import type {Box, VisualInventory} from './schema.ts';
import {Box as BoxSchema, normalize} from './schema.ts';

export const MAX_PDF_BYTES = 50_000_000;
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
Object.assign(globalThis, {DOMMatrix, ImageData, Path2D});
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

export async function readPdf(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || !Buffer.from(bytes.subarray(0,5)).equals(Buffer.from('%PDF-')))
    throw new Error('PDF는 시그니처가 있는 0~50 MB 파일이어야 합니다.');
  let document: PDFDocument;
  try { document = await PDFDocument.load(bytes, {throwOnInvalidObject: true, parseSpeed: ParseSpeeds.Fast, updateMetadata: false}); }
  catch { throw new Error('PDF 구조를 읽을 수 없거나 암호화된 PDF입니다.'); }
  if (document.isEncrypted || document.getPageCount() < 1 || document.getPageCount() > 60)
    throw new Error('암호화되지 않은 PDF 1~60페이지가 필요합니다.');
  return document;
}
export async function slicePdf(document: PDFDocument, pages: number[]) {
  if (!pages.length || new Set(pages).size !== pages.length || pages.some(p => !Number.isInteger(p) || p < 1 || p > document.getPageCount()))
    throw new Error('분리할 페이지 목록이 잘못되었습니다.');
  const result = await PDFDocument.create();
  for (const page of await result.copyPages(document, pages.map(p => p-1))) result.addPage(page);
  const bytes = await result.save();
  if (bytes.length > MAX_PDF_BYTES) throw new Error('분리 PDF가 50 MB를 초과했습니다.');
  return bytes;
}
export async function openRenderer(bytes: Uint8Array) {
  const task = pdfjs.getDocument({data: Uint8Array.from(bytes), stopAtErrors: true,
    useSystemFonts: false, standardFontDataUrl: join(pdfjsRoot,'standard_fonts/'),
    cMapUrl: join(pdfjsRoot,'cmaps/'), cMapPacked: true, wasmUrl: join(pdfjsRoot,'wasm/'),
    verbosity: 0});
  return task.promise;
}
export type Renderer = Awaited<ReturnType<typeof openRenderer>>;
export async function renderPage(document: Renderer, pageNumber: number, box?: Box, target?: number) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('렌더링 페이지 범위 오류.');
  const bounds = BoxSchema.parse(box ?? [0,0,1000,1000]);
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({scale: 1});
  if (![base.width, base.height].every(v => Number.isFinite(v) && v > 0)) throw new Error('PDF 페이지 크기 오류.');
  const [t,l,b,r] = bounds;
  if(target!==undefined&&(!Number.isFinite(target)||target<1||target>4096))throw new Error('렌더링 해상도 범위 오류.');
  // Bound the allocated crop, not the invisible full page. Tall pages can now be inspected at real detail.
  const scale = Math.min(target ?? (box ? 1600 : 2200),4096) /
    Math.max(base.width*(r-l)/1000, base.height*(b-t)/1000);
  const viewport = page.getViewport({scale});
  const width = Math.max(1, Math.ceil(viewport.width*(r-l)/1000));
  const height = Math.max(1, Math.ceil(viewport.height*(b-t)/1000));
  const canvas = createCanvas(width, height);
  await page.render({canvas: canvas as never, canvasContext: canvas.getContext('2d') as never,
    viewport, transform: [1,0,0,1,-viewport.width*l/1000,-viewport.height*t/1000],
    background: 'white'}).promise;
  return canvas;
}
export function pageTiles(width:number,height:number):Box[] {
  if(![width,height].every(n=>Number.isFinite(n)&&n>0))throw new Error('타일 페이지 크기 오류.');
  const ratio=Math.max(width,height)/Math.min(width,height);
  if(ratio<=2.5)return [[0,0,1000,1000]];
  // ponytail: eight strips maximum; distribute over the entire page, never silently omit the final results.
  // Extreme aspect ratios still lose detail; region readability gates admission and crops re-render independently.
  const count=Math.min(8,Math.ceil(ratio/1.7)),length=Math.ceil(1000/(count-(count-1)*.15));
  return Array.from({length:count},(_,i)=>{const start=Math.floor(i*(1000-length)/(count-1)),end=Math.min(1000,start+length);
    return height>=width?[start,0,end,1000]:[0,start,1000,end];});
}
export function pageBox(tile:Box,local:Box):Box {
  const [t,l,b,r]=BoxSchema.parse(tile),[a,x,c,y]=BoxSchema.parse(local);
  return BoxSchema.parse([Math.floor(t+(b-t)*a/1000),Math.floor(l+(r-l)*x/1000),
    Math.ceil(t+(b-t)*c/1000),Math.ceil(l+(r-l)*y/1000)]);
}
export function mergeInventories(parts:Array<{box:Box;inventory:VisualInventory}>):VisualInventory {
  const regions:VisualInventory['regions']=[],links:VisualInventory['links']=[];
  for(const {box,inventory} of parts){const keys=new Map<string,string>();
    for(const region of inventory.regions){const bounds=pageBox(box,region.box);
      const duplicate=regions.find(r=>{if(r.kind!==region.kind||normalize(r.description)!==normalize(region.description))return false;
        const area=(b:Box)=>(b[2]-b[0])*(b[3]-b[1]);
        const overlap=Math.max(0,Math.min(r.box[2],bounds[2])-Math.max(r.box[0],bounds[0]))*
          Math.max(0,Math.min(r.box[3],bounds[3])-Math.max(r.box[1],bounds[1]));
        return overlap/(area(r.box)+area(bounds)-overlap)>.8;});
      const key=duplicate?.key??`r${regions.length+1}`;keys.set(region.key,key);
      if(!duplicate)regions.push({...region,key,box:bounds});}
    for(const link of inventory.links){const from_key=keys.get(link.from_key)!,to_key=keys.get(link.to_key)!;
      if(from_key!==to_key)links.push({...link,from_key,to_key});}
  }
  const last=parts.at(-1)?.box,complete=last?.[2]===1000&&last?.[3]===1000;
  return {coverage:complete&&parts.every(p=>p.inventory.coverage==='complete')?'complete':'partial',regions,links,
    limitations:[...new Set(parts.flatMap(p=>p.inventory.limitations)),...(!complete?['타일 상한으로 페이지 일부를 분석하지 못했습니다.']:[])].slice(0,40)};
}
export async function renderPng(bytes: Uint8Array, page=1, box?: Box) {
  const renderer = await openRenderer(bytes);
  try { return (await renderPage(renderer,page,box)).toBuffer('image/png'); }
  finally { await renderer.loadingTask.destroy(); }
}
export type TextSpan = {text: string; box: Box};
export async function textSpans(document: Renderer, pageNumber: number): Promise<TextSpan[]> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({scale: 1});
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    const height = Math.hypot(matrix[2],matrix[3]);
    const angle = Math.atan2(matrix[1],matrix[0]);
    const dx = Math.cos(angle)*item.width, dy = Math.sin(angle)*item.width;
    const hx = Math.sin(angle)*height, hy = -Math.cos(angle)*height;
    const xs = [matrix[4],matrix[4]+dx,matrix[4]+hx,matrix[4]+dx+hx];
    const ys = [matrix[5],matrix[5]+dy,matrix[5]+hy,matrix[5]+dy+hy];
    spans.push({text:item.str, box:[Math.min(...ys)/viewport.height*1000,Math.min(...xs)/viewport.width*1000,
      Math.max(...ys)/viewport.height*1000,Math.max(...xs)/viewport.width*1000]});
  }
  return spans;
}
export function textInBox(box:Box,spans:TextSpan[]) {
  return spans.filter(s => {
    const cy=(s.box[0]+s.box[2])/2, cx=(s.box[1]+s.box[3])/2;
    return cy>=box[0]-8 && cy<=box[2]+8 && cx>=box[1]-8 && cx<=box[3]+8;
  }).map(s=>s.text).join(' ');
}
function numericBoundaryClipped(quote:string,source:string):boolean {
  const text=normalize(source),chars=[...text.matchAll(/\S/g)],compact=chars.map(m=>m[0]).join(''),key=normalize(quote).replace(/\s/g,'');
  if(!key)return false;
  let clipped=false;
  for(let at=compact.indexOf(key);at>=0;at=compact.indexOf(key,at+1)){
    const end=chars[at+key.length-1],before=text.slice(0,chars[at].index),after=text.slice(end.index+end[0].length);
    // ponytail: conservative numeric-edge check; ambiguous trailing words require a longer quote or image review.
    clipped=(/^\p{N}/u.test(key)&&/[\p{N}+\-‐‑‒–—−~<>≤≥=$€£₩]\s*$/u.test(before))||
      (/\p{N}$/u.test(key)&&/^\s*(?:[\p{L}\p{N}%‰×/°]|[.,]\p{N}|[-‐‑‒–—−~]\s*\p{N})/u.test(after))||
      (/%$/u.test(key)&&/^\s*p(?![a-z])/iu.test(after));
    if(!clipped)return false;
  }
  return clipped;
}
export function alignRangeTypography(quote:string,box:Box,spans:TextSpan[]):string {
  // Copy a uniquely located literal, never infer OCR. Only range dashes and in-word hyphen glyphs may differ.
  // Math minus, missing signs/units, NFKC substitutions and word changes are deliberately excluded.
  const source=normalize(textInBox(box,spans)),chars=[...source.matchAll(/\S/g)]; // UTF-16 offsets, as used by indexOf/slice.
  const compact=chars.map(m=>m[0]).join(''),needle=normalize(quote).replace(/\s/g,'');
  const fold=(s:string)=>s.replace(/(?<=\p{N})[-‐‑‒–](?=\p{N})/gu,'-').replace(/(?<=\p{L})[‐‑](?=\p{L})/gu,'-');
  if(!/(?<=\p{N})[-‐‑‒–](?=\p{N})/u.test(needle)||compact.includes(needle))return quote;
  const haystack=fold(compact),key=fold(needle),at=haystack.indexOf(key);
  if(at<0||haystack.indexOf(key,at+1)>=0)return quote;
  const start=chars[at]?.index,end=chars[at+key.length-1];
  if(start===undefined||!end)return quote;
  const stop=end.index+end[0].length;
  if(/[\p{L}\p{N}+\-−~<>≤≥=$€£₩]/u.test(source[start-1]??'')||
    /[\p{L}\p{N}%‰×/]/u.test(source[stop]??'')||numericBoundaryClipped(source.slice(start,stop),source))return quote;
  return source.slice(start,stop);
}
export function numericQuoteIssue(quote:string,box:Box,spans:TextSpan[]):string|null {
  if(!/\p{N}/u.test(quote))return null;
  if(/\p{N}\s+\p{N}{1,2}(?!\p{N})/u.test(quote))return 'ambiguous_numeric_spacing';
  const source=textInBox(box,spans),fold=(s:string)=>s.normalize('NFKC').replace(/[‐‑‒–—−]/g,'-');
  if(numericBoundaryClipped(quote,source))return 'numeric_text_layer_mismatch';
  if(normalize(source).replace(/\s/g,'').includes(normalize(quote).replace(/\s/g,'')))return null;
  if(fold(source).replace(/\s/g,'').includes(fold(quote).replace(/\s/g,'')))return 'nonverbatim_symbol_transcription';
  const chars=[...fold(source)],kept=chars.flatMap((c,i)=>/[\p{L}\p{N}]/u.test(c)?[{c,i}]:[]);
  const needle=[...fold(quote)].filter(c=>/[\p{L}\p{N}]/u.test(c)).join(''),at=kept.map(x=>x.c).join('').indexOf(needle);
  if(!needle||at<0)return null; // A missing text layer is not evidence that image text is absent.
  const start=kept[at].i,end=kept[at+needle.length-1]?.i;
  if(end===undefined)return null;
  // Include leading/trailing measurement symbols but never repair text from this approximate match.
  const prefix=chars.slice(0,start).join('').match(/[+\-~<>≤≥=$€£₩]\s*$/)?.[0]??'';
  const suffix=chars.slice(end+1).join('').match(/^\s*[%‰×]/)?.[0]??'';
  const slice=prefix+chars.slice(start,end+1).join('')+suffix;
  const signature=(s:string)=>(fold(s).replace(/\s/g,'').match(/\p{N}+(?:[.,]\p{N}+)*|[+\-~→<>≤≥=%‰×/$€£₩]/gu)??[]).join('|');
  return signature(slice)!==signature(quote)?'numeric_text_layer_mismatch':null;
}
export function quoteTranscriptionIssue(quote:string,box:Box,spans:TextSpan[]):string|null {
  const text=quote.trim(),pairs:Record<string,string>={'(' : ')','[':']','{':'}','〈':'〉','《':'》','「':'」','『':'』','【':'】'};
  const close=pairs[text[0]??'']??(/^<\s*\p{L}/u.test(text)?'>':undefined);
  // ponytail: detect only a demonstrably omitted adjacent delimiter; other clipping needs visual review.
  // The original may itself have an unclosed caption. Never repair it or reject it just for typography.
  const compact=(s:string)=>normalize(s).replace(/\s/g,''),source=compact(textInBox(box,spans)),needle=compact(text),at=source.indexOf(needle);
  if(close&&!text.includes(close)&&at>=0&&source[at+needle.length]===close)return 'omitted_source_delimiter';
  return numericQuoteIssue(quote,box,spans);
}
export function quoteLocationCheck(quote: string, box: Box, spans: TextSpan[]): 'matched'|'outside_region'|'not_found'|'unavailable' {
  if (!spans.length) return 'unavailable';
  const compact = (s: string) => normalize(s).replace(/\s/g,'');
  const needle = compact(quote);
  if (compact(textInBox(box,spans)).includes(needle)) return 'matched';
  if (compact(spans.map(s=>s.text).join(' ')).includes(needle)) return 'outside_region';
  // A mixed PDF can have text-layer captions and image-only dashboard text. Absence is not disproof.
  return 'not_found';
}
export async function savePreviews(bytes: Uint8Array, inventory: Array<VisualInventory & {page: number}>, directory: string) {
  await mkdir(directory, {mode:0o700}); // No recursive/existing-directory overwrite.
  const renderer = await openRenderer(bytes);
  try {
    for (const data of inventory) {
      const canvas=await renderPage(renderer,data.page), ctx=canvas.getContext('2d');
      for (const region of data.regions) {
        const [t,l,b,r]=region.box, x=l*canvas.width/1000, y=t*canvas.height/1000;
        ctx.strokeStyle=region.identification==='clear'?'#087443':'#b05000'; ctx.lineWidth=4;
        ctx.strokeRect(x,y,(r-l)*canvas.width/1000,(b-t)*canvas.height/1000);
        ctx.font='24px sans-serif'; ctx.fillStyle=ctx.strokeStyle;
        ctx.fillText(`p${data.page}:${region.key}`,x+4,y+26);
      }
      await writeFile(join(directory,`page-${String(data.page).padStart(3,'0')}.png`),canvas.toBuffer('image/png'),{flag:'wx',mode:0o600});
    }
  } finally { await renderer.loadingTask.destroy(); }
}
