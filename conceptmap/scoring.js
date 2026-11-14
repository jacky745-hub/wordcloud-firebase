// Novak 概念圖計分、個人貢獻值、差異化回饋（純函式、完全決定性）。
// 本檔不含任何特定文本的內容；得分細節只會出現該張圖與該份文本的判讀資料。
// 計分標準（Novak & Gowin, 1984）：關係 1 分、階層 5 分、交叉連結 10 分、例子 1 分。
export const PTS = { relations: 1, hierarchy: 5, cross: 10, examples: 1 };
export const RUBRIC_VERSION = 'novak-1.0';
export const DEFAULT_SETTINGS = { w_concepts: 0.5, w_relations: 1, w_hierarchy: 5, w_cross: 10, w_examples: 1,
  supplement_coef: 1, ring_coef: 0.5, standard_score: '' };

const S = v => String(v ?? '').trim();
const valid = items => (items || []).filter(x => x.valid !== false);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const g = x => String(Math.round(x * 100) / 100);
const pc = x => Number(x).toFixed(1);

export const relKey = r => r.key ? 'R:' + S(r.key) : 'R:' + [S(r.a), S(r.b)].sort().join('|');
export const exKey = e => 'E:' + S(e.parent) + '>' + S(e.item);
export const crossKey = c => 'X:' + [S(c.a), S(c.b)].sort().join('|') + '>' + S(c.via);
const lvOf = r => (r.level === null || r.level === undefined || r.level === '' || r.level === 0) ? null : parseInt(r.level, 10);

// 有效階層數＝由主概念往外(下)連續存在有效從屬連結的層數；放射狀圖以「由中心往外第幾圈」為 level。
export function hierarchyLevels(relations) {
  const lv = new Set(valid(relations).map(lvOf).filter(x => x));
  let n = 0; while (lv.has(n + 1)) n++; return n;
}
const fmtRel = r => `${r.a}${S(r.label) ? ` —${S(r.label)}→ ` : ' — '}${r.b}`;
const num = l => l.length ? l.map((t, i) => `(${i + 1}) ${t}`).join('；') : '（無）';
const join = p => p.filter(Boolean).join('\n');

export function novakScore(a) {
  a = a || {};
  const rels = valid(a.relations), exs = valid(a.examples), crs = valid(a.cross_links), lv = hierarchyLevels(a.relations);
  const counts = { relations: rels.length, hierarchy: lv, examples: exs.length, cross: crs.length };
  const pts = {}; for (const k in counts) pts[k] = counts[k] * PTS[k];
  const total = pts.relations + pts.hierarchy + pts.examples + pts.cross;
  const inv = l => (l || []).filter(x => x.valid === false);
  const rejected = a.rejected || [], comments = a.comments || {}, hier = a.hierarchy || {};
  const rej = cat => rejected.filter(x => (x.category || 'relations') === cat).map(x => `${x.desc}（${x.reason}）`);
  const unlabeled = rels.filter(r => !S(r.label));
  const notes = items => items.filter(x => x.note).map(x => `「${'a' in x ? fmtRel(x) : x.item}」：${x.note}`);

  let dRel = '有效連結：' + num(rels.map(fmtRel));
  const ncRel = inv(a.relations).map(x => `${fmtRel(x)}（${x.note || '與文本不符或關係不成立'}）`).concat(rej('relations'));
  if (ncRel.length) dRel += '\n未計分：' + num(ncRel);
  const eRel = [comments.relations || ''];
  if (unlabeled.length) eRel.push(`有 ${unlabeled.length} 條有效連線沒有寫連接詞（例如「${fmtRel(unlabeled[0])}」），因兩端概念的關係與文本相符仍給分，但請補上連接詞，讓每條線都能唸成一句完整的話。`);
  eRel.push(...notes(rels));

  const chain = hier.chain || [];
  let dH = chain.length ? `有效階層 ${lv} 層：` + chain.join(' → ') : `有效階層 ${lv} 層`;
  const by = {}; rels.forEach(r => { const l = lvOf(r); if (l) (by[l] = by[l] || []).push(fmtRel(r)); });
  const ks = Object.keys(by).map(Number).filter(k => k <= lv).sort((x, y) => x - y);
  if (ks.length) dH += '\n' + ks.map(k => `第${k}階：${by[k].join('、')}`).join('\n');
  const rejH = rej('hierarchy'); if (rejH.length) dH += '\n未計為階層：' + num(rejH);

  let dEx = '有效例子：' + num(exs.map(e => `${e.item}（${e.parent}的例子）`));
  const rejE = inv(a.examples).map(x => `${x.item}（${x.note || '不是文本中的例子或未連到所屬概念'}）`).concat(rej('examples'));
  if (rejE.length) dEx += '\n未計分：' + num(rejE);

  let dCr = '有效交叉連結：' + num(crs.map(c => `${c.a} ↔ ${c.b}` + (c.via ? `（${c.via}）` : '')));
  const rejC = inv(a.cross_links).map(x => `${x.a} ↔ ${x.b}（${x.note || '不成立'}）`).concat(rej('cross_links'));
  if (rejC.length) dCr += '\n未計分：' + num(rejC);
  const eCr = [comments.cross_links || '', ...crs.filter(c => c.note).map(c => `「${c.a} ↔ ${c.b}」：${c.note}`)];
  if (!crs.length && !comments.cross_links) eCr.push('這張圖目前沒有跨分支的連結。交叉連結是把『不同分支』的概念連起來並說明關係，是概念圖中最能展現統整能力的部分。');

  const conflicts = a.conflicts || [];
  const rows = [
    { 項目: '關係（連結）', 得分細節: dRel, 得分: `${counts.relations} 個 × 1 分 = ${pts.relations} 分`, 說明: join(eRel) },
    { 項目: '階層', 得分細節: dH, 得分: `${counts.hierarchy} 層 × 5 分 = ${pts.hierarchy} 分`, 說明: join([comments.hierarchy || '', hier.note || '']) },
    { 項目: '例子', 得分細節: dEx, 得分: `${counts.examples} 個 × 1 分 = ${pts.examples} 分`, 說明: join([comments.examples || '', ...notes(exs)]) },
    { 項目: '交叉連結', 得分細節: dCr, 得分: `${counts.cross} 個 × 10 分 = ${pts.cross} 分`, 說明: join(eCr) },
    { 項目: '總分', 得分細節: conflicts.length ? '與文本不一致之處：' + num(conflicts) : '未發現與文本相違背的內容。', 得分: `${total} 分`, 說明: '' },
  ];
  return { counts, pts, total, rows, unlabeled: unlabeled.length };
}

function conceptNodes(a) {
  const ids = new Set();
  (a.nodes || []).forEach(n => { if (!n.example && n.valid !== false) ids.add(S(n.id)); });
  if (!ids.size) {
    valid(a.relations).forEach(r => { ids.add(S(r.a)); ids.add(S(r.b)); });
    valid(a.cross_links).forEach(c => { ids.add(S(c.a)); ids.add(S(c.b)); });
  }
  valid(a.examples).forEach(e => ids.delete(S(e.item)));
  ids.delete(''); return ids;
}

// 協作個人貢獻分數 C = Σ w·D（D1 概念數量、D2 關係鏈品質、D3 層次構建、D4 交叉創新、D5 實例準確性）
// 每維度 = 協作圖上以該生顏色畫出的有效項目 ＋ 補登（個人圖有效、協作圖未呈現者 × 補登係數）；D1 另加圈選認同。
export function contribution(collab, individuals, settings = {}, standardScore = null) {
  const st = { ...DEFAULT_SETTINGS, ...settings };
  const w = { w_concepts: +st.w_concepts, w_relations: +st.w_relations, w_hierarchy: +st.w_hierarchy, w_cross: +st.w_cross, w_examples: +st.w_examples };
  const s = +st.supplement_coef, ringC = +st.ring_coef;
  const seats = Object.keys(individuals), n = Math.max(seats.length, 1);
  const cRel = valid(collab.relations), cEx = valid(collab.examples), cCr = valid(collab.cross_links);
  const allNodes = (collab.nodes || []).filter(x => x.valid !== false), cNodes = allNodes.filter(x => !x.example);
  const ckRel = new Set(cRel.map(relKey)), ckEx = new Set(cEx.map(exKey)), ckCr = new Set(cCr.map(crossKey));
  const ckNodes = new Set([...cEx.map(e => S(e.item)), ...allNodes.map(x => S(x.id))]);
  allNodes.forEach(x => (x.covers || []).forEach(v => ckNodes.add(S(v))));
  const T_raw = novakScore(collab).total;
  const ownedTotal = [...cNodes, ...cRel, ...cEx, ...cCr].filter(x => S(x.owner)).length;
  const P = {}; seats.forEach(k => P[k] = novakScore(individuals[k]).total);
  const Pmean = mean(Object.values(P));
  const uRel = new Set(ckRel), uEx = new Set(ckEx), uCr = new Set(ckCr), uLv = new Set(cRel.map(lvOf).filter(x => x));
  const res = {};
  for (const seat of seats) {
    const a = individuals[seat], own = x => S(x.owner) === S(seat);
    const iRel = valid(a.relations), iEx = valid(a.examples), iCr = valid(a.cross_links);
    const ik = new Set([...iRel.map(relKey), ...iEx.map(exKey), ...iCr.map(crossKey)]);
    const aNodes = cNodes.filter(own), aRel = cRel.filter(own), aEx = cEx.filter(own), aCr = cCr.filter(own);
    const rings = allNodes.filter(x => !own(x) && (x.rings || []).map(S).includes(S(seat)));
    const sNodes = [...conceptNodes(a)].filter(x => !ckNodes.has(x)).sort();
    const sRel = iRel.filter(r => !ckRel.has(relKey(r))), sEx = iEx.filter(e => !ckEx.has(exKey(e))), sCr = iCr.filter(c => !ckCr.has(crossKey(c)));
    sRel.forEach(r => { uRel.add(relKey(r)); const l = lvOf(r); if (l) uLv.add(l); });
    sEx.forEach(e => uEx.add(exKey(e))); sCr.forEach(c => uCr.add(crossKey(c)));
    const lvA = new Set(aRel.map(lvOf).filter(x => x));
    const lvS = [...new Set(sRel.map(lvOf).filter(x => x && !lvA.has(x)))].sort((x, y) => x - y);
    const D = { concepts: aNodes.length + s * sNodes.length + ringC * rings.length, relations: aRel.length + s * sRel.length,
      hierarchy: lvA.size + s * lvS.length, cross: aCr.length + s * sCr.length, examples: aEx.length + s * sEx.length };
    const C = w.w_concepts * D.concepts + w.w_relations * D.relations + w.w_hierarchy * D.hierarchy + w.w_cross * D.cross + w.w_examples * D.examples;
    const newItems = aRel.filter(x => !ik.has(relKey(x))).length + aEx.filter(x => !ik.has(exKey(x))).length + aCr.filter(x => !ik.has(crossKey(x))).length;
    const bonus = Math.min(10, rings.length + 2 * newItems);
    const authoredN = aNodes.length + aRel.length + aEx.length + aCr.length, share = ownedTotal ? authoredN / ownedTotal : 0;
    const role = (authoredN && share >= 1.5 / n) ? '主導型' : (share <= 0.5 / n ? '沉默型' : '均衡型');
    res[seat] = { D, C: r2(C), P: P[seat], bonus, role, share: r1(share * 100), authored_n: authoredN,
      authored: { nodes: aNodes.map(x => x.id), relations: aRel.map(fmtRel), examples: aEx.map(e => e.item), cross: aCr.map(c => `${c.a} ↔ ${c.b}`) },
      rings: rings.map(x => x.id),
      supplement: { nodes: sNodes, relations: sRel.map(fmtRel), examples: sEx.map(e => e.item), cross: sCr.map(c => `${c.a} ↔ ${c.b}`), levels: lvS },
      new_in_collab: newItems };
  }
  let ul = 0; while (uLv.has(ul + 1)) ul++;
  const T_adj = uRel.size * PTS.relations + ul * PTS.hierarchy + uCr.size * PTS.cross + uEx.size * PTS.examples;
  const std = standardScore ? +standardScore : (T_adj || 1);
  const stats = {}; seats.forEach(k => stats[k] = novakScore(individuals[k]).counts);
  const sv = Object.values(stats), medH = median(sv.map(v => v.hierarchy)), medR = median(sv.map(v => v.relations)), medE = median(sv.map(v => v.examples));
  for (const seat of seats) {
    const r = res[seat], p = r.P, c = r.C, x = stats[seat];
    r.f1 = T_adj ? r1((p * 0.6 + c * 0.4) / T_adj * 100) : 0;
    r.f2 = r1(((p ? c / p : 0) + (Pmean ? p / Pmean : 0)) / 2 * 100);
    r.f3 = std ? r1((p * 0.4 + c * 0.6 + r.bonus) / std * 100) : 0;
    const exRatio = p ? x.examples / p : 0;
    r.path = (x.examples >= medE && exRatio >= 0.15 && x.examples > 0) ? '強實例→抽象概念轉化策略'
      : (x.hierarchy >= medH && x.relations >= medR && x.hierarchy > 0) ? '強組織力→系統思維訓練' : '基礎鷹架→階層與連接詞練習';
  }
  for (const k of ['f1', 'f2', 'f3']) [...seats].sort((a, b) => res[b][k] - res[a][k]).forEach((seat, i) => res[seat][k + '_rank'] = i + 1);
  return { res, summary: { T_raw, T_adj, P_mean: r2(Pmean), standard: std, weights: w, supplement_coef: s, ring_coef: ringC, n,
    union: { relations: uRel.size, levels: ul, cross: uCr.size, examples: uEx.size } } };
}

export const bandOf = (total, std) => { const r = std ? total / std : 0; return r >= 0.55 ? '進階' : r >= 0.35 ? '發展中' : '起步'; };

export function individualFeedback(name, a, score, inv, standard) {
  inv = inv || {};
  const c = score.counts, total = score.total, band = bandOf(total, standard), who = name || '同學';
  const strengths = (a.strengths || []).slice(0, 4), trouble = (a.weaknesses || []).slice(0, 4), conflicts = a.conflicts || [];
  const have = conceptNodes(a); valid(a.examples).forEach(e => have.add(S(e.item)));
  const missing = (inv.concepts || []).filter(x => x.importance === 'core' && ![x.id, ...(x.aliases || [])].some(v => have.has(v))).map(x => x.id).slice(0, 5);
  const root = a.root || inv.root || '主概念';
  const parts = [{
    進階: `${who}，你的概念圖很有架構！共畫出 ${c.relations} 個有效連結、${c.hierarchy} 個階層、${c.examples} 個例子、${c.cross} 個交叉連結，總分 ${total} 分，看得出來你把文本讀得很仔細。`,
    發展中: `${who}，你已經抓到文本的主要骨架了：${c.relations} 個有效連結、${c.hierarchy} 個階層、${c.examples} 個例子，總分 ${total} 分。再補上幾個地方，這張圖會完整很多。`,
    起步: `${who}，謝謝你認真完成這張圖！你已經畫出 ${c.relations} 個有效連結、${c.hierarchy} 個階層、${c.examples} 個例子（總分 ${total} 分），這是很好的起點，我們一步一步把它長大。`,
  }[band]];
  if (strengths.length) parts.push('【你做得好的地方】' + strengths.join('；') + '。');
  if (score.unlabeled) trouble.push(`有 ${score.unlabeled} 條連線上沒有寫連接詞，別人看圖時不容易知道兩個概念是什麼關係`);
  if (conflicts.length) trouble.push('有和文本不一致的地方：' + conflicts.join('、'));
  if (trouble.length) parts.push('【目前卡住的地方】' + trouble.join('；') + '。');
  if (missing.length) parts.push('【文本中還沒放進圖裡的重點】' + missing.map(m => `「${m}」`).join('、') + '。');
  const steps = [];
  if (band === '起步') {
    steps.push(`先從「${root}」出發，把大概念放中間（或最上面），越細的概念放越外圈（越下面）`);
    if (missing.length) steps.push(`回到文本找出「${missing[0]}」和哪個概念有關，畫一條線並在線上寫 2～4 個字的連接詞（如：分為、具有、例如）`);
    steps.push('每畫一條線，就試著把它唸成一句話；唸得通，這條線就是有效的連結');
  } else if (band === '發展中') {
    if (score.unlabeled) steps.push('把沒有連接詞的線補上連接詞，這是最快讓圖變清楚的方法');
    if (missing.length) steps.push('把上面列出的文本重點挑 2 個接到正確的上層概念底下，階層就會再往外長一層');
    if (c.examples < 3) steps.push('替最外層的概念各補一個文本中提到的具體例子');
    steps.push('檢查每個例子、每個性質是不是掛在『對的概念』底下');
  } else {
    if (c.cross === 0) { const h = inv.cross_hints || []; steps.push('挑戰交叉連結：找出兩個不同分支中彼此有關的概念，畫一條線並寫清楚關係' + (h.length ? `（提示：${h[0]}）` : '')); }
    if (score.unlabeled) steps.push('替每條線補上精準的連接詞，讓整張圖可以被別人獨立讀懂');
    if (missing.length) steps.push('把尚未納入的文本重點整合進現有分支');
    steps.push('試著用自己的話，把整張圖從主概念講到最外層，檢查有沒有講不順的地方');
  }
  parts.push('【下一步可以這樣做】' + steps.map((t, i) => `${i + 1}. ${t}`).join('；') + '。');
  if (inv.analogy && band !== '進階') parts.push('【幫助理解的小比喻】' + inv.analogy);
  parts.push({ 進階: '你已經有很好的統整能力，再往『跨分支的關聯』挑戰看看，老師很期待你的下一版！',
    發展中: '你離完整的概念圖只差幾步，照上面的建議修改後再上傳一次，分數會明顯進步，加油！',
    起步: '不用急，每次多加一條唸得通的連結就是進步。修改後再上傳，老師會看見你的成長！' }[band]);
  return { text: parts.join('\n'), band };
}

export function contributionFeedback(name, r, sm) {
  const who = name || '同學', au = r.authored, su = r.supplement, n = sm.n;
  const nSupp = su.relations.length + su.examples.length + su.cross.length;
  const lst = (items, k = 4) => items.slice(0, k).join('、') + (items.length > k ? '…等' : '');
  const drew = [];
  if (au.nodes.length) drew.push(`寫下概念「${lst(au.nodes)}」`);
  if (au.relations.length) drew.push(`畫出連結「${lst(au.relations, 3)}」`);
  if (au.examples.length) drew.push(`舉出例子「${lst(au.examples)}」`);
  const drewTxt = drew.length ? drew.join('；') : '還沒有用自己的顏色寫下概念或畫出連線';
  const ringTxt = r.rings.length ? `，並且圈選認同了 ${r.rings.length} 個同學寫的概念（${lst(r.rings)}）` : '';
  let f1 = `【公式一 加權平均法】${who} 的貢獻值為 ${pc(r.f1)}%（全組第 ${r.f1_rank}/${n} 名）。算法：（個人圖 ${r.P} 分 × 0.6 ＋ 協作個人貢獻 ${r.C} 分 × 0.4）÷ 協作圖總分（含補登）${sm.T_adj} 分。在協作圖上，你${drewTxt}${ringTxt}。`;
  f1 += nSupp ? `另外，你個人圖上有 ${nSupp} 項有效內容（如：${lst([...su.relations, ...su.examples, ...su.cross], 3)}）沒有出現在協作圖上，系統已依規則幫你補登為貢獻。下次協作時，記得把這些好內容也畫上去，讓全組都受益。`
    : '你個人圖上的有效內容都已呈現在協作圖中。';
  const ratio = r.P ? Math.round(r.C / r.P * 100) : 0, rel = sm.P_mean ? Math.round(r.P / sm.P_mean * 100) : 0;
  let f2 = `【公式二 相對提升法】貢獻值為 ${pc(r.f2)}%（全組第 ${r.f2_rank}/${n} 名）。它由兩部分平均而成：①你把個人圖的實力帶進協作的程度＝協作貢獻 ${r.C} ÷ 個人圖 ${r.P} ＝ ${ratio}%；②你的個人圖相對於全組平均（${sm.P_mean} 分）的水準＝${rel}%。`;
  f2 += ratio < 70 ? '①偏低，代表你會的比你在協作中表現出來的多——你個人圖上的許多內容是由別的同學先畫上協作圖的。下次試著主動認領一個分支來畫。'
    : ratio > 110 ? '①超過 100%，代表你在協作時貢獻的比個人圖還多，是很棒的協作表現！也可以回頭把這些新想法補進自己的圖。'
    : '①接近 100%，代表你把自己會的內容相當完整地帶進了小組。';
  if (rel < 80) f2 += '②低於平均沒關係，先照個人圖的回饋把階層和連結補起來，這個數字自然會上升。';
  const f3 = `【公式三 綜合貢獻指數法】貢獻值為 ${pc(r.f3)}%（全組第 ${r.f3_rank}/${n} 名）。算法：（個人圖 ${r.P} × 0.4 ＋ 協作貢獻 ${r.C} × 0.6 ＋ 協作效益加成 ${g(r.bonus)}）÷ 標準分數 ${g(sm.standard)}。協作效益加成來自：圈選認同同學的概念 ${r.rings.length} 個（每個 1 分）、在協作中畫出個人圖沒有的新內容 ${r.new_in_collab} 項（每項 2 分），上限 10 分。`;
  let gd;
  if (r.role === '主導型') gd = `【分層指導：傾聽整合】協作圖上有 ${r.share}% 的內容出自你的筆，你是這組的重要推手，謝謝你的投入！下一步的挑戰是『傾聽整合』：動筆前先問一位還沒畫的組員「你的圖上有什麼是我們還沒放的？」，請他親手畫上去，你負責幫忙檢查連接詞。能帶動全組一起完成，是比自己畫完更高一層的能力。`;
  else if (r.role === '沉默型') gd = `【分層指導：貢獻鷹架】這次協作圖上以你的顏色寫下或畫出的內容比較少（${r.share}%），`
    + (r.rings.length ? `不過你用圈選表達了對 ${r.rings.length} 個概念的認同，也是參與的一種。` : '') + '其實你的個人圖有不少協作圖上沒有的好內容'
    + (nSupp ? `（例如：${lst([...su.relations, ...su.examples], 3)}）` : '')
    + '。下次可以這樣開始：①先從自己的圖挑『一條』最有把握的連結；②對組員說「我想補這一條」；③親手畫上去並寫上連接詞。一次一條就很好。';
  else gd = `【分層指導：穩定貢獻】你在協作圖上的內容佔 ${r.share}%，參與度適中。下一步可以試著擔任『連結者』：找出兩位同學畫的不同分支之間有什麼關係，補上一條交叉連結。`;
  const path = { '強組織力→系統思維訓練': '【學習路徑：系統思維訓練】你的階層與連結是強項。建議練習：選兩個不同分支的概念，問自己「如果其中一個改變，另一個會怎樣？」，把答案畫成交叉連結。',
    '強實例→抽象概念轉化策略': '【學習路徑：抽象概念轉化】你很會舉例。建議練習：把同一類的例子圈起來，替它們想一個共同的上位概念或共同性質，寫成一個新的節點，讓例子『升級』成概念。',
    '基礎鷹架→階層與連接詞練習': '【學習路徑：階層與連接詞】建議練習：先把文本中的概念依『大→小』排成三層，再用「分為、具有、例如」這三種連接詞把它們接起來。' }[r.path] || '';
  return { f1, f2, f3, guidance: gd + '\n' + path };
}

// 把一組判讀算成完整結果（存入資料庫的就是這個物件）
export function scoreGroup(bundle, members, settings = {}) {
  const inv = bundle.inventory || {}, inds = {};
  members.forEach(m => inds[m.seat] = bundle.individual[m.seat]);
  const std = settings.standard_score ? +settings.standard_score : (inv.standard_score || null);
  const { res, summary } = contribution(bundle.collab, inds, settings, std);
  const cs = novakScore(bundle.collab);
  const out = { summary, collab: { counts: cs.counts, pts: cs.pts, total: cs.total, rows: cs.rows }, members: {} };
  for (const m of members) {
    const sc = novakScore(inds[m.seat]), fb = individualFeedback(m.name, inds[m.seat], sc, inv, summary.standard);
    out.members[m.seat] = { counts: sc.counts, pts: sc.pts, total: sc.total, rows: sc.rows, feedback: fb.text, band: fb.band,
      contribution: res[m.seat], cfeedback: contributionFeedback(m.name, res[m.seat], summary) };
  }
  return out;
}
