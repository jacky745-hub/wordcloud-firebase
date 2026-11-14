// 檔案處理：把上傳的 PDF／圖片轉成一張 JPEG 存檔（Firestore 單筆上限 1MB，故壓到約 0.9MB 以內）。
// 「是否同一張圖」以原始檔位元組的 SHA-256＋頁碼判定，與壓縮無關。
import { sha256Hex } from './store.js';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/';
let pdfjs;
async function pdfLib() {
  if (!pdfjs) { pdfjs = await import(PDFJS + 'pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; }
  return pdfjs;
}
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const cache = new WeakMap();   // 同一個檔案（整組合併 PDF）只讀一次
async function bytesOf(file) { if (!cache.has(file)) cache.set(file, { buf: await file.arrayBuffer() }); return cache.get(file); }

function toJpeg(canvas) {
  let w = canvas.width, h = canvas.height, c = canvas;
  for (let side = 2200; side >= 900; side -= 260) {
    const k = Math.min(1, side / Math.max(w, h));
    c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(canvas, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.72, 0.6]) { const d = c.toDataURL('image/jpeg', q).split(',')[1]; if (d.length < 900000) return { data: d, w: c.width, h: c.height }; }
  }
  throw new Error('這張圖太複雜，無法壓縮到可儲存的大小，請降低掃描解析度後再上傳。');
}

// 回傳 { data(JPEG base64), w, h, sha(原檔), name, page }
export async function fileToImage(file, page = 1) {
  const c = await bytesOf(file);
  c.sha = c.sha || await sha256Hex(c.buf);
  let canvas;
  if (isPdf(file)) {
    const lib = await pdfLib();
    c.pdf = c.pdf || await lib.getDocument({ data: c.buf.slice(0) }).promise;
    if (page < 1 || page > c.pdf.numPages) throw new Error(`「${file.name}」只有 ${c.pdf.numPages} 頁，沒有第 ${page} 頁。`);
    const pg = await c.pdf.getPage(page), vp0 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: 2200 / Math.max(vp0.width, vp0.height) });
    canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } else {
    let bmp;
    try { bmp = await createImageBitmap(new Blob([c.buf], { type: file.type || 'image/*' })); }
    catch { throw new Error(`「${file.name}」不是瀏覽器能讀取的圖片。概念圖請上傳 PDF 或 JPG／PNG／WEBP／GIF／BMP（Word、PPT、HEIC 請先另存成 PDF 或 JPG）。`); }
    canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height; canvas.getContext('2d').drawImage(bmp, 0, 0);
  }
  return { ...toJpeg(canvas), sha: c.sha, name: file.name, page };
}

// 文本檔：TXT 直接讀；PDF 擷取文字層
export async function fileToText(file) {
  if (!isPdf(file)) return (await file.text()).trim();
  const lib = await pdfLib(), pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent(); let last = null;
    for (const it of tc.items) { if (last !== null && Math.abs(it.transform[5] - last) > 2) out += '\n'; out += it.str; last = it.transform[5]; }
    out += '\n';
  }
  out = out.trim();
  if (out.length < 30) throw new Error('這個 PDF 是掃描圖，讀不到文字。請改用「貼上文本內容」。');
  return out;
}
