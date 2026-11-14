import { openStore, isLocal, ROLES, ROLE_LABEL, rank, friendly, sha256Hex, memberKey, ADMIN_USERNAME } from './store.js';
import { scoreGroup, RUBRIC_VERSION, DEFAULT_SETTINGS } from './scoring.js';
import { fileToImage, fileToText } from './files.js';
import * as ai from './ai.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const g = x => String(Math.round(x * 100) / 100), pc = x => Number(x).toFixed(1) + '%';
const dt = t => t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '';
const STATUS = { scored: '已評分', pending: '待判讀', scoring: '評分中' };
const view = $('#view'), nav = $('#nav');
let store, me = null, flashMsg = '';
const flash = m => { flashMsg = m; };
const go = h => { if (location.hash === h) render(); else location.hash = h; };
const busy = (btn, on, label) => { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = label || '處理中…'; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; };
const show = (html) => { view.innerHTML = (flashMsg ? `<div class="flash">${esc(flashMsg)}</div>` : '') + html; flashMsg = ''; window.scrollTo(0, 0); };
const notice = m => { let f = $('.flash', view); if (!f) { f = document.createElement('div'); f.className = 'flash'; view.prepend(f); } f.textContent = m; f.scrollIntoView({ block: 'center' }); };
const download = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };

// ------------------------------------------------------------------ 判讀快取鍵與評分流程
const invKey = textSha => sha256Hex(['inventory', RUBRIC_VERSION, textSha].join('|'));
const mapKey = (sub, m) => m
  ? sha256Hex(['individual', RUBRIC_VERSION, sub.textId, m.sha, m.page, m.seat].join('|'))
  : sha256Hex(['collab', RUBRIC_VERSION, sub.textId, sub.collab.sha, sub.collab.page, sub.members.map(x => x.seat + ':' + x.color).join(',')].join('|'));

async function gather(sub, useAI, onStep = () => {}) {
  const missing = [], engines = new Set(), text = await store.getText(sub.textId);
  const obtain = async (key, kind, label, produce) => {
    const row = await store.getAnalysis(key);
    if (row) { engines.add(row.engine); return JSON.parse(row.json); }
    if (useAI && ai.getKey()) {
      onStep(`AI 判讀中：${label}…`);
      const data = await produce();
      await store.putAnalysis(key, { kind, engine: 'AI:' + ai.MODEL, json: JSON.stringify(data), at: Date.now() });
      engines.add('AI:' + ai.MODEL); return data;
    }
    missing.push(label); return null;
  };
  const img = async id => (await store.getImage(id)).data;
  const inventory = await obtain(await invKey(sub.textId), 'inventory', '文本概念清單', () => ai.buildInventory(text.content));
  const individual = {};
  for (const m of sub.members) individual[m.seat] = await obtain(await mapKey(sub, m), 'individual', `座號 ${m.seat} 個人圖`,
    async () => ai.analyzeMap(text.content, inventory || {}, await img(m.imgId), { seat: m.seat }));
  const collab = await obtain(await mapKey(sub), 'collab', '協作圖',
    async () => ai.analyzeMap(text.content, inventory || {}, await img(sub.collab.imgId), { collab: true, members: sub.members }));
  return { bundle: { inventory, collab, individual }, missing, engine: [...engines].sort().join('、') };
}

// 只有教師以上的瀏覽器會寫入分數（安全規則也只允許教師以上寫入），學生端無法竄改。
async function scoreSub(id, useAI, onStep) {
  const sub = await store.getSub(id);
  const { bundle, missing, engine } = await gather(sub, useAI, onStep);
  if (missing.length) {
    await store.updateSub(id, { status: 'pending', statusMsg: '檔案已存檔。尚待判讀：' + missing.join('、') + '。' });
    return { ok: false, missing };
  }
  const settings = { ...DEFAULT_SETTINGS, ...(await store.getSettings()) };
  const result = scoreGroup(bundle, sub.members, settings);
  await store.updateSub(id, { status: 'scored', statusMsg: '評分完成', engine, result, scoredAt: Date.now() });
  return { ok: true };
}
const BLANK_MAP = { root: '', nodes: [], relations: [], examples: [], cross_links: [], rejected: [], hierarchy: { chain: [], note: '' },
  comments: { relations: '', hierarchy: '', examples: '', cross_links: '' }, strengths: [], weaknesses: [], conflicts: [] };
const BLANK_INV = { title: '', root: '', concepts: [], reference: { relations: 0, levels: 0, cross_links: 0, examples: 0, items: [] }, standard_score: 0, cross_hints: [], analogy: '' };
async function currentBundle(sub) {
  const { bundle } = await gather(sub, false);
  const individual = {}; sub.members.forEach(m => individual[m.seat] = bundle.individual[m.seat] || BLANK_MAP);
  return { inventory: bundle.inventory || BLANK_INV, collab: bundle.collab || BLANK_MAP, individual };
}
async function importBundle(sub, raw) {
  let data; try { data = JSON.parse(raw); } catch { throw new Error('這不是正確的 JSON 格式，請檢查括號與逗號。'); }
  if (!data || typeof data !== 'object' || !data.collab || !data.individual) throw new Error('JSON 需包含 inventory、collab、individual 三個部分。');
  const lack = sub.members.filter(m => !data.individual[m.seat]).map(m => m.seat);
  if (lack.length) throw new Error('缺少座號 ' + lack.join('、') + ' 的個人圖判讀。');
  const engine = '人工判讀:' + me.username, put = async (k, kind, d) => store.putAnalysis(await k, { kind, engine, json: JSON.stringify(d), at: Date.now() });
  if (data.inventory) await put(invKey(sub.textId), 'inventory', data.inventory);
  await put(mapKey(sub), 'collab', data.collab);
  for (const m of sub.members) await put(mapKey(sub, m), 'individual', data.individual[m.seat]);
  return scoreSub(sub.id, false);
}

// ------------------------------------------------------------------ 導覽列
function drawNav() {
  const cur = (location.hash || '#/').split('/')[1] || '';
  const a = (h, t) => `<a href="${h}" class="${h.split('/')[1] === cur ? 'on' : ''}">${t}</a>`;
  nav.innerHTML = me
    ? a('#/', rank(me) >= 1 ? '全部小組' : '我的小組') + a('#/upload', '上傳概念圖')
      + (rank(me) >= 1 ? a('#/export', '資料下載') : '') + (rank(me) >= 2 ? a('#/users', '帳號管理') + a('#/settings', '系統設定') : (rank(me) === 1 ? a('#/settings', 'AI 設定') : ''))
      + a('#/account', '我的帳號') + `<span class="who">${esc(me.name || me.username)}（${ROLE_LABEL[me.role]}）</span><button id="logout">登出</button>`
    : a('#/login', '登入') + a('#/register', '註冊');
  const lo = $('#logout'); if (lo) lo.onclick = async () => { await store.logout(); flash('已登出。'); go('#/login'); };
}

// ------------------------------------------------------------------ 頁面
const pages = {};
pages.landing = () => show(`
 <div class="card"><h2>一組同學、一份文本、每人一種顏色</h2>
 <p>同組同學在同一個頁面上傳：<b>概念圖文本</b>、每個人用單一顏色畫的<b>個人概念圖</b>，以及全組一起畫的<b>協作概念圖</b>。系統依 Novak 概念圖評分準則（關係 1 分、階層 5 分、例子 1 分、交叉連結 10 分）並對照文本評分，計算每個人的<b>個人貢獻值</b>，給你一份專屬的回饋。</p>
 <p><a class="btn" href="#/login">登入</a> <a class="btn ghost" href="#/register">第一次使用？註冊帳號</a></p></div>
 <div class="grid"><div class="card"><h3>① 上傳</h3><p class="hint">校名、班級只填一次；每位組員填座號、姓名、顏色並選自己的圖。支援 PDF 與圖片。</p></div>
 <div class="card"><h3>② 評分</h3><p class="hint">每一條連結、每一個階層、例子、交叉連結都對照文本判讀；圖上沒畫的不會給分。</p></div>
 <div class="card"><h3>③ 回饋</h3><p class="hint">看得到哪裡做得好、哪裡卡住、下一步怎麼改；修改後可再上傳，比較自己的進步。</p></div></div>`);

pages.login = () => {
  show(`<div class="card narrow"><h2>登入</h2><form id="f"><label>帳號</label><input name="u" required autocomplete="username">
  <label>密碼</label><input name="p" type="password" required autocomplete="current-password">
  <p><button class="btn">登入</button> <a class="btn ghost" href="#/register">註冊新帳號</a></p></form></div>`);
  $('#f').onsubmit = async e => {
    e.preventDefault(); const b = $('button', e.target); busy(b, true, '登入中…');
    try { await store.login(e.target.u.value.trim(), e.target.p.value); location.hash = '#/'; } catch (x) { busy(b, false); notice(friendly(x)); }
  };
};
pages.register = () => {
  show(`<div class="card mid"><h2>註冊</h2><form id="f">
  <div class="grid"><div><label>帳號（英文或數字，至少 3 字元）</label><input name="username" required pattern="[A-Za-z0-9_.\\-]{3,30}" autocomplete="username"></div><div><label>姓名</label><input name="name"></div></div>
  <div class="grid"><div><label>密碼（至少 6 字元）</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div><div><label>再輸入一次密碼</label><input name="password2" type="password" required></div></div>
  <div class="grid"><div><label>校名</label><input name="school"></div><div><label>班級</label><input name="cls"></div><div><label>座號（學生）</label><input name="seat"></div></div>
  <p class="hint">註冊後身分為「學生」。教師、管理者身分由 admin 在「帳號管理」指派。</p>
  <p><button class="btn">註冊</button> <a class="btn ghost" href="#/login">已有帳號，去登入</a></p></form></div>`);
  $('#f').onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), b = $('button', e.target);
    if (f.password !== f.password2) return notice('兩次輸入的密碼不一致。');
    busy(b, true, '註冊中…');
    try { await store.register({ ...f, username: f.username.trim(), name: f.name.trim(), school: f.school.trim(), cls: f.cls.trim(), seat: f.seat.trim() }); flash('註冊成功，歡迎使用！'); location.hash = '#/'; }
    catch (x) { busy(b, false); notice(friendly(x)); }
  };
};
pages.account = () => {
  show(`<div class="card mid"><h2>我的帳號</h2><p>帳號：<b>${esc(me.username)}</b>　身分：<span class="tag">${ROLE_LABEL[me.role]}</span></p>
  <form id="f"><div class="grid"><div><label>姓名</label><input name="name" value="${esc(me.name)}"></div><div><label>校名</label><input name="school" value="${esc(me.school)}"></div>
  <div><label>班級</label><input name="cls" value="${esc(me.cls)}"></div><div><label>座號</label><input name="seat" value="${esc(me.seat)}"></div></div><p><button class="btn">儲存資料</button></p></form>
  <h3>修改密碼</h3><form id="p"><div class="grid"><div><label>目前密碼</label><input name="o" type="password" required></div><div><label>新密碼（至少 6 字元）</label><input name="n" type="password" required minlength="6"></div></div>
  <p><button class="btn ghost">修改密碼</button></p></form></div>`);
  $('#f').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); for (const k in d) d[k] = d[k].trim();
    try { await store.updateProfile(me.uid, d); Object.assign(me, d); drawNav(); notice('資料已儲存。'); } catch (x) { notice(friendly(x)); } };
  $('#p').onsubmit = async e => { e.preventDefault(); try { await store.changePassword(e.target.o.value, e.target.n.value); e.target.reset(); notice('密碼已更新。'); } catch (x) { notice(friendly(x)); } };
};

pages.home = async () => {
  const subs = await store.listSubs(me), staff = rank(me) >= 1;
  show(`<h2>${staff ? '全部小組' : '我的小組'}</h2><p><a class="btn" href="#/upload">＋ 上傳新的小組概念圖</a></p>` + (subs.length ? `
  <div class="tablewrap"><table><tr><th>校名／班級／組別</th><th>文本</th><th>組員座號</th><th>狀態</th>${staff ? '<th>判讀</th><th>上傳者</th>' : ''}<th>上傳時間</th><th></th></tr>
  ${subs.map(s => `<tr><td>${esc(s.school)} ${esc(s.cls)} ${esc(s.group)}</td><td>${esc(s.textTitle)}</td><td>${s.members.map(m => esc(m.seat)).join('、')}</td>
  <td><span class="tag ${s.status === 'scored' ? 'ok' : 'warn'}">${STATUS[s.status] || s.status}</span></td>${staff ? `<td>${esc(s.engine || '')}</td><td>${esc(s.createdByName || '')}</td>` : ''}
  <td class="num">${dt(s.createdAt)}</td><td class="nw"><a class="btn sm" href="#/sub/${s.id}">查看</a>${staff ? ` <button class="btn danger sm" data-del="${s.id}">刪除</button>` : ''}</td></tr>`).join('')}</table></div>`
    : `<div class="card"><p>還沒有資料。請按上方按鈕，和組員一起上傳文本、個人概念圖與協作概念圖。</p></div>`));
  $$('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('確定刪除這筆小組資料與其評分？')) return; try { await store.deleteSub(b.dataset.del); flash('已刪除該筆小組資料。'); render(); } catch (x) { notice(friendly(x)); } });
};

pages.upload = async () => {
  const texts = (await store.listTexts()).sort((a, b) => b.at - a.at);
  show(`<h2>上傳小組概念圖</h2><p class="hint">同組同學請在這一頁一起完成。校名、班級只填一次；每位組員各填一列。<b>幾位組員就有幾種顏色</b>，個人圖用的顏色要和協作圖上的顏色相同。</p>
  <form id="f"><div class="card"><h3>① 小組資料（全組共用）</h3><div class="grid">
   <div><label>校名 *</label><input name="school" required value="${esc(me.school)}"></div><div><label>班級 *</label><input name="cls" required value="${esc(me.cls)}"></div>
   <div><label>組別（可不填）</label><input name="group" placeholder="例：A 組"></div></div></div>
  <div class="card"><h3>② 概念圖文本（評分依據）</h3><p class="hint">請提供同學們畫概念圖時所讀的文本。三種方式擇一：選用已有的文本、貼上文字、或上傳 PDF／TXT 檔。</p>
   ${texts.length ? `<label>選用已有的文本</label><select name="textId"><option value="">— 不選用，改用下方貼上或上傳 —</option>${texts.map(t => `<option value="${t.id}">${esc(t.title)}（${dt(t.at).split(' ')[0]}）</option>`).join('')}</select>` : ''}
   <label>文本標題</label><input name="textTitle"><label>貼上文本內容</label><textarea name="textContent"></textarea>
   <label>或上傳文本檔（文字型 PDF、TXT）</label><input type="file" name="textFile" accept=".pdf,.txt,text/plain,application/pdf"></div>
  <div class="card"><h3>③ 組員與個人概念圖（每人單一顏色）</h3><div id="members"></div><p><button type="button" class="btn ghost" id="add">＋ 新增一位組員</button></p>
   <details><summary>個人圖是「整組掃描成同一個 PDF」嗎？</summary><p class="hint">可在這裡上傳合併檔，並在每位組員的「頁碼」填他在第幾頁；組員列的檔案欄就可以留空。</p><input type="file" name="shared" accept=".pdf,application/pdf"></details></div>
  <div class="card"><h3>④ 協作概念圖（全組一起畫、含所有組員的顏色）</h3><div class="grid"><div><label>協作概念圖檔案 *（PDF 或圖片）</label><input type="file" name="collab" required accept=".pdf,image/*"></div>
   <div><label>頁碼（多頁 PDF 才需要）</label><input name="collabPage" type="number" min="1" value="1"></div></div></div>
  <p><button class="btn" id="go">上傳並存檔</button> <span class="hint" id="prog"></span></p></form>
  <datalist id="colors">${['紅', '橘', '粉橘', '黃', '綠', '淺綠', '藍', '淺藍', '紫', '粉紅', '咖啡', '黑', '灰'].map(c => `<option value="${c}">`).join('')}</datalist>`);
  const box = $('#members');
  const add = () => { const d = document.createElement('div'); d.className = 'member'; d.innerHTML = `<div class="grid"><div><label>座號 *</label><input data-k="seat" inputmode="numeric"></div><div><label>姓名</label><input data-k="name"></div>
    <div><label>顏色 *</label><input data-k="color" list="colors" placeholder="例：紅"></div><div><label>個人概念圖（PDF 或圖片）</label><input type="file" data-k="file" accept=".pdf,image/*"></div>
    <div><label>頁碼</label><input data-k="page" type="number" min="1" value="1"></div><div class="end"><button type="button" class="btn danger sm">移除這位</button></div></div>`;
    $('button', d).onclick = () => box.children.length > 2 ? d.remove() : notice('協作概念圖至少需要 2 位組員。'); box.appendChild(d); };
  $('#add').onclick = add; for (let i = 0; i < 4; i++) add();
  $('#f').onsubmit = async e => {
    e.preventDefault(); const f = e.target, btn = $('#go'), prog = m => $('#prog').textContent = m;
    try {
      const rows = $$('.member', box).map(d => { const v = k => $(`[data-k=${k}]`, d); return { seat: v('seat').value.trim(), name: v('name').value.trim(), color: v('color').value.trim(), file: v('file').files[0], page: parseInt(v('page').value, 10) || 1 }; })
        .filter(r => r.seat || r.name || r.color || r.file);
      const shared = f.shared.files[0];
      if (rows.length < 2) throw new Error('協作概念圖至少需要 2 位組員。');
      for (const [i, r] of rows.entries()) { if (!r.seat) throw new Error(`第 ${i + 1} 位組員沒有填座號。`); if (!r.color) throw new Error(`座號 ${r.seat} 沒有填顏色。`); if (!r.file && !shared) throw new Error(`座號 ${r.seat} 沒有上傳個人概念圖。`); }
      if (new Set(rows.map(r => r.seat)).size !== rows.length) throw new Error('組員座號重複了，請檢查。');
      if (new Set(rows.map(r => r.color)).size !== rows.length) throw new Error('每位組員的顏色必須不同（幾位組員就有幾種顏色）。');
      let textId = f.textId?.value || '', title = f.textTitle.value.trim(), content = f.textContent.value.trim();
      if (!textId && !content && !f.textFile.files[0]) throw new Error('請選擇、貼上或上傳「概念圖文本」。');
      busy(btn, true, '處理中…');
      if (!textId) {
        if (!content) { prog('讀取文本檔…'); content = await fileToText(f.textFile.files[0]); }
        textId = await sha256Hex(content.split(/\s+/).join(' '));
        if (!await store.getText(textId)) await store.putText(textId, { title: title || content.slice(0, 20), content, by: me.uid, at: Date.now() });
        else title = title || (await store.getText(textId)).title;
      }
      const textTitle = title || (await store.getText(textId)).title;
      const save = async (file, page, label) => { prog(`處理並上傳：${label}…`); const im = await fileToImage(file, page); const id = crypto.randomUUID();
        await store.putImage(id, { data: im.data, w: im.w, h: im.h, sha: im.sha, name: im.name, page, by: me.uid, at: Date.now() }); return { imgId: id, sha: im.sha, page, fileName: im.name }; };
      const members = [];
      for (const r of rows) members.push({ seat: r.seat, name: r.name, color: r.color, ...(await save(r.file || shared, r.page, `座號 ${r.seat} 個人圖`)) });
      const collab = await save(f.collab.files[0], parseInt(f.collabPage.value, 10) || 1, '協作圖');
      const school = f.school.value.trim(), cls = f.cls.value.trim();
      const id = await store.createSub({ school, cls, group: f.group.value.trim(), textId, textTitle, members, collab, memberKeys: members.map(m => memberKey(school, cls, m.seat)),
        status: 'pending', statusMsg: '檔案已存檔，等待教師判讀評分。', engine: '', result: null, createdBy: me.uid, createdByName: me.username, createdAt: Date.now(), scoredAt: null });
      flash('上傳成功，所有檔案已存檔。');
      if (rank(me) >= 1) { prog('檢查是否已有判讀…'); try { await scoreSub(id, false); } catch { /* 留待結果頁處理 */ } }
      go('#/sub/' + id);
    } catch (x) { busy(btn, false); prog(''); notice(x.code ? friendly(x) : x.message); }
  };
};

const scoreTable = rows => `<div class="tablewrap"><table><tr><th>項目</th><th>得分細節</th><th>得分</th><th>說明</th></tr>${rows.map(r => `<tr><td><b>${esc(r.項目)}</b></td><td class="pre">${esc(r.得分細節)}</td><td class="num">${esc(r.得分)}</td><td class="pre">${esc(r.說明)}</td></tr>`).join('')}</table></div>`;

pages.sub = async id => {
  let sub = await store.getSub(id);
  if (!sub) return show(`<div class="card"><h2>無法檢視</h2><p>找不到這筆資料，或您沒有檢視權限。</p><a class="btn" href="#/">回首頁</a></div>`);
  const staff = rank(me) >= 1, R = sub.result, sm = R?.summary, scored = sub.status === 'scored' && R;
  const only = (!staff && me.seat && sub.members.some(m => m.seat === me.seat)) ? me.seat : null;   // 學生只看自己的詳細回饋
  let h = `<h2>${esc(sub.school)} ${esc(sub.cls)} ${esc(sub.group)}</h2>
  <p>文本：<b>${esc(sub.textTitle)}</b>　上傳：${dt(sub.createdAt)}　<span class="tag ${scored ? 'ok' : 'warn'}">${STATUS[sub.status] || sub.status}</span>${sub.engine ? ` <span class="tag">判讀：${esc(sub.engine)}</span>` : ''}</p>
  <p class="noprint">${staff ? `<button class="btn ghost sm" id="rescore">重新計分</button> <button class="btn ghost sm" id="aiBtn">AI 判讀並評分</button> <a class="btn ghost sm" href="#/analysis/${id}">判讀匯入／修正</a> ` : ''}
  <button class="btn ghost sm" id="textBtn">查看文本</button> <button class="btn ghost sm" id="print">列印／存成 PDF</button> <span class="hint" id="prog"></span></p>
  <div id="textBox"></div>`;
  if (!scored) h += `<div class="card"><p>${esc(sub.statusMsg)}</p>${staff ? `<p class="hint">請按「AI 判讀並評分」（需先在設定填入金鑰），或到「判讀匯入／修正」匯入判讀。</p>` : `<p class="hint">老師完成判讀後，重新整理這一頁就能看到分數與回饋。</p>`}</div>`;
  h += `<div class="card"><h3>組員與原始檔案</h3><div class="tablewrap"><table><tr><th>座號</th><th>姓名</th><th>顏色</th><th>個人概念圖</th>${scored ? '<th>個人圖總分</th><th>協作貢獻分</th><th>公式一</th><th>公式二</th><th>公式三</th><th>類型</th>' : ''}</tr>
   ${sub.members.map(m => { const c = scored && R.members[m.seat]?.contribution; return `<tr><td class="num">${esc(m.seat)}</td><td>${esc(m.name)}</td><td>${esc(m.color)}</td>
    <td><a href="#" data-img="${m.imgId}">${esc(m.fileName)}</a>${m.page !== 1 ? `（第 ${m.page} 頁）` : ''}</td>${c ? `<td class="num">${g(c.P)}</td><td class="num">${g(c.C)}</td><td class="num">${pc(c.f1)}</td><td class="num">${pc(c.f2)}</td><td class="num">${pc(c.f3)}</td><td>${c.role}</td>` : ''}</tr>`; }).join('')}
   </table></div><p>協作概念圖：<a href="#" data-img="${sub.collab.imgId}">${esc(sub.collab.fileName)}</a></p>
   ${scored ? `<p class="hint">個人圖平均 ${sm.P_mean} 分；協作圖原始分 ${sm.T_raw} 分，含補登後 ${sm.T_adj} 分；標準分數 ${g(sm.standard)} 分；補登係數 ${sm.supplement_coef}。<br>
   公式一＝(個人×0.6＋協作貢獻×0.4)÷協作圖總分(含補登)；公式二＝[(協作貢獻÷個人)＋(個人÷全組平均)]÷2；公式三＝(個人×0.4＋協作貢獻×0.6＋協作效益加成)÷標準分數。</p>` : ''}</div><div id="imgBox"></div>`;
  if (scored) {
    for (const m of sub.members) {
      if (only && only !== m.seat) continue;
      const x = R.members[m.seat], c = x.contribution, D = c.D, w = sm.weights, f = x.cfeedback;
      h += `<div class="card"><h3>座號 ${esc(m.seat)}　${esc(m.name)}　<span class="tag">${esc(m.color)}</span>　個人概念圖：${g(x.total)} 分</h3>${scoreTable(x.rows)}
      <h3>給 ${esc(m.name || '你')} 的回饋（個人概念圖）</h3><div class="fb">${esc(x.feedback)}</div><h3>個人貢獻值</h3>
      <div class="tablewrap"><table><tr><th>維度</th><th>D1 概念數量</th><th>D2 關係鏈品質</th><th>D3 層次構建</th><th>D4 交叉創新</th><th>D5 實例準確性</th><th>協作個人貢獻分數</th></tr>
      <tr><td>數量</td><td class="num">${g(D.concepts)}</td><td class="num">${g(D.relations)}</td><td class="num">${g(D.hierarchy)}</td><td class="num">${g(D.cross)}</td><td class="num">${g(D.examples)}</td><td class="num" rowspan="2"><b>${g(c.C)}</b></td></tr>
      <tr><td>權重</td><td class="num">× ${g(w.w_concepts)}</td><td class="num">× ${g(w.w_relations)}</td><td class="num">× ${g(w.w_hierarchy)}</td><td class="num">× ${g(w.w_cross)}</td><td class="num">× ${g(w.w_examples)}</td></tr></table></div>
      <p class="hint">協作圖上親筆：概念 ${c.authored.nodes.length}、連結 ${c.authored.relations.length}、例子 ${c.authored.examples.length}、交叉 ${c.authored.cross.length}；圈選認同 ${c.rings.length}；補登：概念 ${c.supplement.nodes.length}、連結 ${c.supplement.relations.length}、例子 ${c.supplement.examples.length}、交叉 ${c.supplement.cross.length}。</p>
      <div class="fb">${esc(f.f1)}</div><div class="fb">${esc(f.f2)}</div><div class="fb">${esc(f.f3)}</div><div class="fb">${esc(f.guidance)}</div></div>`;
    }
    h += `<div class="card"><h3>協作概念圖：${g(R.collab.total)} 分（依圖上實際畫出的內容）</h3>${scoreTable(R.collab.rows)}</div>`;
  }
  show(h);
  $('#print').onclick = () => window.print();
  $('#textBtn').onclick = async () => { const b = $('#textBox'); if (b.innerHTML) return b.innerHTML = ''; const t = await store.getText(sub.textId); b.innerHTML = `<div class="card"><h3>${esc(t.title)}</h3><div class="pre">${esc(t.content)}</div></div>`; };
  $$('[data-img]').forEach(a => a.onclick = async e => { e.preventDefault(); const b = $('#imgBox'); b.innerHTML = '<p class="hint">載入原圖…</p>';
    try { const im = await store.getImage(a.dataset.img); b.innerHTML = `<div class="card"><p><b>${esc(a.textContent)}</b>　<a download="${esc(a.textContent.replace(/\.\w+$/, ''))}.jpg" href="data:image/jpeg;base64,${im.data}">下載</a>　<a href="#" id="closeImg">關閉</a></p><img class="map" src="data:image/jpeg;base64,${im.data}"></div>`;
      $('#closeImg').onclick = ev => { ev.preventDefault(); b.innerHTML = ''; }; b.scrollIntoView({ behavior: 'smooth' }); } catch (x) { b.innerHTML = `<div class="flash">${esc(friendly(x))}</div>`; } });
  if (staff) {
    const run = (btn, useAI) => async () => {
      if (useAI && !ai.getKey()) return notice('尚未設定 AI 金鑰。請到上方選單的設定頁填入 Anthropic API 金鑰，或使用「判讀匯入／修正」。');
      busy(btn, true); try { const r = await scoreSub(id, useAI, m => $('#prog').textContent = m);
        flash(r.ok ? (useAI ? '判讀與評分完成。' : '已重新計分。同一張圖沿用既有判讀，分數保持一致。') : '尚待判讀：' + r.missing.join('、') + '。'); render(); }
      catch (x) { busy(btn, false); $('#prog').textContent = ''; notice(x.code ? friendly(x) : x.message); } };
    $('#rescore').onclick = run($('#rescore'), false); $('#aiBtn').onclick = run($('#aiBtn'), true);
  }
};

pages.analysis = async id => {
  const sub = await store.getSub(id); if (!sub) return go('#/');
  show(`<h2>判讀匯入／修正　${esc(sub.school)} ${esc(sub.cls)} ${esc(sub.group)}</h2>
  <div class="card"><p>這裡是每張圖的「逐項判讀」資料（JSON）。分數完全由這份判讀依 Novak 標準計算而得。教師可以：下載 → 對照原圖修改（例如把誤判的連結 valid 改成 false）→ 貼回或上傳 → 系統重新計分。</p>
  <p class="hint">組員座號：${sub.members.map(m => `${esc(m.seat)}（${esc(m.color)}）`).join('、')}。relations 每筆：a、b、label（連接詞）、valid、level（子概念所在階層，非從屬關係填 null）、owner（協作圖上是誰畫的）、note。</p>
  <p><button class="btn ghost sm" id="dl">下載目前判讀 JSON</button> <a class="btn ghost sm" href="#/sub/${id}">回評分結果</a></p></div>
  <form id="f" class="card"><label>上傳判讀 JSON 檔</label><input type="file" name="file" accept=".json,application/json">
  <label>或直接編輯</label><textarea name="bundle" class="mono tall" spellcheck="false"></textarea><p><button class="btn">匯入並重新計分</button></p></form>`);
  const ta = $('[name=bundle]'); ta.value = JSON.stringify(await currentBundle(sub), null, 1);
  $('#dl').onclick = () => download(`analysis_${id}.json`, new Blob([ta.value], { type: 'application/json' }));
  $('#f').onsubmit = async e => { e.preventDefault(); const b = $('button', e.target); busy(b, true);
    try { const file = e.target.file.files[0]; const r = await importBundle(sub, file ? (await file.text()).replace(/^﻿/, '') : ta.value);
      flash(r.ok ? '判讀已匯入並完成計分。' : '已匯入，但仍缺：' + r.missing.join('、')); go('#/sub/' + id); }
    catch (x) { busy(b, false); notice(x.code ? friendly(x) : '匯入未完成：' + x.message); } };
};

pages.users = async () => {
  const users = (await store.listUsers()).sort((a, b) => rank(b) - rank(a) || a.username.localeCompare(b.username)), admins = users.filter(u => u.role === 'admin').length;
  show(`<h2>帳號管理</h2><p class="hint">admin 可剔除任何管理者、教師、學生並變更身分；管理者可剔除教師與學生。被剔除的帳號無法再登入使用；已上傳的概念圖與評分紀錄會保留。忘記密碼者：請剔除舊帳號後，用新的帳號名稱重新註冊。</p>
  <div class="tablewrap"><table><tr><th>帳號</th><th>姓名</th><th>身分</th><th>校名／班級／座號</th><th>註冊時間</th><th>操作</th></tr>
  ${users.map(u => { const can = u.id !== me.uid && (me.role === 'admin' || rank(u) < rank(me)); return `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td>
   <td>${me.role === 'admin' && u.id !== me.uid ? `<select data-role="${u.id}">${ROLES.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>` : `<span class="tag">${ROLE_LABEL[u.role]}</span>`}</td>
   <td>${esc(u.school)} ${esc(u.cls)} ${esc(u.seat)}</td><td class="num">${dt(u.createdAt).split(' ')[0]}</td><td>${can ? `<button class="btn danger sm" data-kick="${u.id}" data-n="${esc(u.username)}" data-r="${u.role}">剔除</button>` : '<span class="hint">—</span>'}</td></tr>`; }).join('')}</table></div>`);
  $$('[data-role]').forEach(s => s.onchange = async () => { try { await store.setRole(s.dataset.role, s.value); flash('身分已更新為 ' + ROLE_LABEL[s.value] + '。'); } catch (x) { flash(friendly(x)); } render(); });
  $$('[data-kick]').forEach(b => b.onclick = async () => { if (b.dataset.r === 'admin' && admins <= 1) return notice('系統至少要保留一位 admin。'); if (!confirm(`確定剔除 ${b.dataset.n}？`)) return;
    try { await store.deleteUser(b.dataset.kick); flash(`已剔除帳號 ${b.dataset.n}。`); } catch (x) { flash(friendly(x)); } render(); });
};

pages.settings = async () => {
  const mgr = rank(me) >= 2, s = { ...DEFAULT_SETTINGS, ...(await store.getSettings()) };
  const inp = (k, l) => `<div><label>${l}</label><input name="${k}" value="${esc(s[k])}"></div>`;
  show(`<h2>${mgr ? '系統設定' : 'AI 設定'}</h2>` + (mgr ? `<form id="f" class="card"><h3>貢獻值五維度權重（貢獻值 = Σ wᵢ · Dimensionᵢ）</h3><div class="grid">
   ${inp('w_concepts', 'w₁ 概念數量')}${inp('w_relations', 'w₂ 關係鏈品質')}${inp('w_hierarchy', 'w₃ 層次構建')}${inp('w_cross', 'w₄ 交叉創新')}${inp('w_examples', 'w₅ 實例準確性')}</div>
   <h3>補登與圈選</h3><div class="grid">${inp('supplement_coef', '補登係數（個人圖有、協作圖沒呈現的內容以幾成計入；1＝全額）')}${inp('ring_coef', '圈選係數（圈起別人寫的概念，每個算幾個概念）')}${inp('standard_score', '公式三的標準分數（留空＝用該文本標準參考圖的分數）')}</div>
   <p><button class="btn">儲存設定</button></p><p class="hint">Novak 計分標準固定為：關係 1 分、階層 5 分、例子 1 分、交叉連結 10 分，不開放修改。新設定在按「重新計分」時生效。</p></form>` : '') +
  `<form id="k" class="card"><h3>AI 判讀金鑰（只存在這台裝置）</h3><p class="hint">填入您自己的 Anthropic API 金鑰後，評分結果頁的「AI 判讀並評分」即可使用（模型：${ai.MODEL}）。金鑰只儲存在您這台裝置的瀏覽器，不會上傳到資料庫，其他人看不到；換一台裝置需重新填寫。請勿在公用電腦上儲存。</p>
   <label>Anthropic API 金鑰　${ai.getKey() ? '<span class="tag ok">已設定</span>' : '<span class="tag warn">未設定</span>'}</label><input name="key" type="password" placeholder="sk-ant-…" autocomplete="off">
   <p><button class="btn">儲存金鑰</button> <button type="button" class="btn danger" id="clr">清除金鑰</button></p></form>`);
  if (mgr) $('#f').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    for (const k in d) { d[k] = d[k].trim(); if (d[k] !== '' && isNaN(+d[k])) return notice('權重與係數請填數字。'); if (d[k] === '' && k !== 'standard_score') return notice('權重與係數不可留空。'); }
    try { await store.putSettings(d); notice('設定已儲存。'); } catch (x) { notice(friendly(x)); } };
  $('#k').onsubmit = e => { e.preventDefault(); const v = e.target.key.value.trim(); if (!v) return notice('請先貼上金鑰。'); ai.setKey(v); flash('金鑰已儲存在這台裝置。'); render(); };
  $('#clr').onclick = () => { ai.setKey(''); flash('已清除這台裝置上的金鑰。'); render(); };
};

// ------------------------------------------------------------------ 資料下載
async function tables() {
  const subs = (await store.listSubs(me)).sort((a, b) => a.createdAt - b.createdAt), t = {};
  t['小組'] = [['小組編號', '校名', '班級', '組別', '文本標題', '組員人數', '狀態', '判讀引擎', '協作圖原始分', '協作圖總分(含補登)', '個人圖平均', '標準分數', '補登係數', '上傳者', '上傳時間', '評分時間', '協作圖檔名', '協作圖SHA256']];
  t['個人與協作圖評分'] = [['小組編號', '校名', '班級', '組別', '圖別', '座號', '姓名', '顏色', '關係數', '關係分', '階層數', '階層分', '例子數', '例子分', '交叉連結數', '交叉連結分', '總分', '回饋', '檔名', '頁碼', '檔案SHA256', '上傳時間']];
  t['評分細節'] = [['小組編號', '校名', '班級', '圖別', '座號', '姓名', '項目', '得分細節', '得分', '說明']];
  t['貢獻值'] = [['小組編號', '校名', '班級', '組別', '座號', '姓名', '顏色', '個人圖分數', 'D1概念數量', 'D2關係鏈品質', 'D3層次構建', 'D4交叉創新', 'D5實例準確性', '協作個人貢獻分數', '協作效益加成', '公式一(%)', '公式二(%)', '公式三(%)', '協作類型', '學習路徑', '協作圖親筆內容', '圈選認同', '補登內容', '公式一回饋', '公式二回饋', '公式三回饋', '分層指導與路徑', '上傳時間']];
  for (const s of subs) {
    const R = s.status === 'scored' ? s.result : null, sm = R?.summary || {}, base = [s.id, s.school, s.cls];
    t['小組'].push([...base, s.group, s.textTitle, s.members.length, STATUS[s.status] || s.status, s.engine || '', sm.T_raw ?? '', sm.T_adj ?? '', sm.P_mean ?? '', sm.standard ?? '', sm.supplement_coef ?? '', s.createdByName || '', dt(s.createdAt), dt(s.scoredAt), s.collab.fileName, s.collab.sha]);
    if (!R) continue;
    const scoreRow = (kind, m, x, file) => { const c = x.counts, p = x.pts;
      t['個人與協作圖評分'].push([...base, s.group, kind, m?.seat || '', m?.name || '', m?.color || '', c.relations, p.relations, c.hierarchy, p.hierarchy, c.examples, p.examples, c.cross, p.cross, x.total, x.feedback || '', file.fileName, file.page, file.sha, dt(s.createdAt)]);
      x.rows.forEach(r => t['評分細節'].push([...base, kind, m?.seat || '', m?.name || '', r.項目, r.得分細節, r.得分, r.說明])); };
    scoreRow('協作圖', null, R.collab, s.collab);
    for (const m of s.members) { const x = R.members[m.seat], c = x.contribution, f = x.cfeedback, au = c.authored, su = c.supplement; scoreRow('個人圖', m, x, m);
      t['貢獻值'].push([...base, s.group, m.seat, m.name, m.color, c.P, c.D.concepts, c.D.relations, c.D.hierarchy, c.D.cross, c.D.examples, c.C, c.bonus, c.f1, c.f2, c.f3, c.role, c.path,
        [...au.nodes, ...au.relations, ...au.examples, ...au.cross].join('；'), c.rings.join('；'), [...su.relations, ...su.examples, ...su.cross].join('；'), f.f1, f.f2, f.f3, f.guidance, dt(s.createdAt)]); }
  }
  if (rank(me) >= 2) t['使用者'] = [['帳號', '姓名', '身分', '校名', '班級', '座號', '註冊時間'], ...(await store.listUsers()).map(u => [u.username, u.name, ROLE_LABEL[u.role], u.school, u.cls, u.seat, dt(u.createdAt)])];
  return { t, subs };
}
const csv = rows => '﻿' + rows.map(r => r.map(v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('下載元件載入失敗，請檢查網路後再試。')); document.head.appendChild(s); });

pages.export = async () => {
  const names = ['小組', '個人與協作圖評分', '評分細節', '貢獻值'].concat(rank(me) >= 2 ? ['使用者'] : []);
  show(`<h2>資料下載</h2><div class="card"><h3>全部資料（Excel，一個檔案多個工作表）</h3><p><button class="btn" id="xlsx">下載 conceptmap_all.xlsx</button></p>
  <p class="hint">工作表：小組、個人與協作圖評分、評分細節（項目／得分細節／得分／說明）、貢獻值（五維度、三公式、回饋）${rank(me) >= 2 ? '、使用者' : ''}。可直接匯入 SPSS／R／Excel 做統計分析。</p></div>
  <div class="card"><h3>單一資料表（CSV，UTF-8，可用 Excel 直接開啟）</h3><p>${names.map(n => `<button class="btn ghost" data-csv="${n}">${n}.csv</button>`).join(' ')}</p></div>
  <div class="card"><h3>原始檔案與判讀紀錄</h3><p><button class="btn ghost" id="zip">所有上傳的概念圖（ZIP）</button> <button class="btn ghost" id="ana">逐項判讀紀錄（JSON）</button></p>
  <p class="hint" id="prog">概念圖以上傳時轉存的 JPEG 保存。判讀紀錄保存每張圖逐條連結／階層／例子／交叉連結的判定與理由，可供信度檢核。</p></div>`);
  const wrap = (b, fn) => b.onclick = async () => { busy(b, true, '準備中…'); try { await fn(); } catch (x) { notice(x.code ? friendly(x) : x.message); } busy(b, false); };
  $$('[data-csv]').forEach(b => wrap(b, async () => download(`conceptmap_${{ 小組: 'groups', 個人與協作圖評分: 'scores', 評分細節: 'details', 貢獻值: 'contributions', 使用者: 'users' }[b.dataset.csv]}.csv`, new Blob([csv((await tables()).t[b.dataset.csv])], { type: 'text/csv;charset=utf-8' }))));
  wrap($('#xlsx'), async () => { await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); const { t } = await tables(), wb = XLSX.utils.book_new();
    for (const n in t) { const ws = XLSX.utils.aoa_to_sheet(t[n]); ws['!cols'] = t[n][0].map(h => ({ wch: Math.min(50, Math.max(10, String(h).length * 2 + 2)) })); XLSX.utils.book_append_sheet(wb, ws, n); }
    XLSX.writeFile(wb, 'conceptmap_all.xlsx'); });
  wrap($('#zip'), async () => { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'); const zip = new JSZip(), { subs } = await tables(); let n = 0;
    for (const [i, s] of subs.entries()) { const dir = `${String(i + 1).padStart(4, '0')}_${s.school}_${s.cls}_${s.group}`.replace(/_+$/, '').replace(/[\\/:*?"<>|]/g, '-');
      for (const it of [{ id: s.collab.imgId, name: '協作圖' }, ...s.members.map(m => ({ id: m.imgId, name: `個人圖_座號${m.seat}` }))]) { $('#prog').textContent = `打包中…已處理 ${++n} 張`; const im = await store.getImage(it.id); if (im) zip.file(`${dir}/${it.name}.jpg`, im.data, { base64: true }); } }
    download('conceptmap_files.zip', await zip.generateAsync({ type: 'blob' })); $('#prog').textContent = `完成，共 ${n} 張。`; });
  wrap($('#ana'), async () => download('conceptmap_analysis.json', new Blob([JSON.stringify((await store.listAnalysis()).map(r => ({ key: r.id, kind: r.kind, engine: r.engine, at: dt(r.at), data: JSON.parse(r.json) })), null, 1)], { type: 'application/json' })));
};

// ------------------------------------------------------------------ 路由
async function render() {
  drawNav();
  const [, name = '', arg] = (location.hash || '#/').split('/');
  const pub = ['login', 'register'];
  try {
    if (!me) return pub.includes(name) ? pages[name]() : (name ? go('#/login') : pages.landing());
    if (pub.includes(name) || !name) return name ? go('#/') : await pages.home();
    const need = { export: 1, analysis: 1, users: 2, settings: 1 }[name] || 0;
    if (!pages[name] || name === 'landing' || name === 'home') return show(`<div class="card"><h2>找不到頁面</h2><p>這個網址不存在，請從選單重新進入。</p><a class="btn" href="#/">回首頁</a></div>`);
    if (rank(me) < need) return show(`<div class="card"><h2>權限不足</h2><p>您的身分無法使用這項功能。</p><a class="btn" href="#/">回首頁</a></div>`);
    await pages[name](arg);
  } catch (x) { console.error(x); show(`<div class="card"><h2>暫時無法顯示</h2><p>${esc(x.code ? friendly(x) : (x.message || '請重新整理頁面再試一次。'))}</p><a class="btn" href="#/">回首頁</a></div>`); }
}

(async () => {
  try { store = await openStore(); }
  catch (x) { return show(`<div class="card"><h2>系統載入未完成</h2><p>請檢查網路連線後重新整理頁面。</p><p class="hint">${esc(x.message || '')}</p></div>`); }
  if (isLocal) $('#mode').innerHTML = '<div class="flash">本機試用模式：資料只存在這台裝置的瀏覽器，不會同步給其他人。第一個以帳號「admin」註冊的人即為最高管理者。</div>';
  window.addEventListener('hashchange', render);
  store.onAuth((u, msg) => { me = u; if (msg) flash(msg); render(); });
})();
