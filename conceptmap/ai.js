// AI 判讀（選用）：教師在「系統設定」填入自己的 Anthropic API 金鑰，金鑰只存在該教師這台裝置的瀏覽器，不會上傳、不會進版控。
// AI 只負責「看圖列出實際畫出的項目並對照文本判定是否成立」；分數一律由 scoring.js 以固定規則計算。
export const MODEL = 'claude-opus-5-5';
const KEY = 'cm_anthropic_key';
export const getKey = () => localStorage.getItem(KEY) || '';
export const setKey = k => k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY);

const STR = { type: 'string' }, BOOL = { type: 'boolean' }, ARR = { type: 'array', items: STR };
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const LEVEL = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const INVENTORY_SCHEMA = obj({ title: STR, root: STR,
  concepts: { type: 'array', items: obj({ id: STR, aliases: ARR, importance: { type: 'string', enum: ['core', 'support'] } }) },
  reference: obj({ relations: { type: 'integer' }, levels: { type: 'integer' }, cross_links: { type: 'integer' }, examples: { type: 'integer' }, items: ARR }),
  cross_hints: ARR, analogy: STR });
const MAP_SCHEMA = obj({ root: STR,
  nodes: { type: 'array', items: obj({ id: STR, owner: STR, rings: ARR, covers: ARR, example: BOOL, valid: BOOL }) },
  relations: { type: 'array', items: obj({ a: STR, b: STR, label: STR, valid: BOOL, level: LEVEL, owner: STR, note: STR }) },
  examples: { type: 'array', items: obj({ parent: STR, item: STR, valid: BOOL, owner: STR, note: STR }) },
  cross_links: { type: 'array', items: obj({ a: STR, b: STR, via: STR, valid: BOOL, owner: STR, note: STR }) },
  rejected: { type: 'array', items: obj({ category: { type: 'string', enum: ['relations', 'hierarchy', 'examples', 'cross_links'] }, desc: STR, reason: STR }) },
  hierarchy: obj({ chain: ARR, note: STR }), comments: obj({ relations: STR, hierarchy: STR, examples: STR, cross_links: STR }),
  strengths: ARR, weaknesses: ARR, conflicts: ARR });

const SYSTEM = `你是國中自然科的學科專家與概念圖評量者，依 Novak & Gowin 的概念圖計分法判讀學生手繪概念圖。
你的工作只有「判讀」，不計算分數。請先把文本精讀至少三遍並牢記，再逐一檢視圖上的每個節點與每條線。

鐵則（違反任何一條都會造成評分錯誤）：
1. 只記錄圖上「實際畫出」的東西。兩個概念之間必須看得到一條線（或箭頭、明確的短線記號）才算有連結；只是寫在旁邊、上下排列、框線相鄰而沒有線，一律不算連結，改列入 rejected 並說明「未畫連線」。
2. 每一條連結都要對照文本判定 valid：兩端概念的關係與文本相符才是 true；與文本無關、與文本矛盾、或看不出關係者為 false，並在 note 說明原因。完全與文本無關也不是例子的內容不予計分。
3. 階層：以主概念為第 0 層，由上往下（放射狀圖則由中心往外）判定。relations 的 level 填「子概念所在層數」，只有『上位概念→更特殊的下位概念／其屬性』的從屬關係才填數字；同層並列、因果串接、未接回主概念的片段填 null。
4. 例子：必須是具體的事物或事件，且有線連到它所屬的概念，才列入 examples。指向例子的連線不重複列入 relations。
5. 交叉連結：連接「不同分支」的概念且關係成立，才列入 cross_links；同一分支內上下層的線不是交叉連結。
6. 節點 id 一律優先使用「文本概念清單」中的名稱；圖上的同義寫法請對應到清單名稱，清單沒有的才用學生原文。一個框內寫了多個概念時，用 covers 列出。
7. 不確定的字跡不要猜成對學生有利的內容；看不清楚就列入 rejected，原因寫「字跡無法辨識」。
8. comments、strengths、weaknesses 要具體指出這張圖的內容（哪個概念、哪條線），用國中生看得懂、委婉鼓勵的語氣；conflicts 只列出與文本相違背之處，沒有就給空陣列。
9. 不得加入圖上沒有的內容，也不得引用本說明或其他圖的內容當作這張圖的得分細節。`;

// 把 Anthropic API 的英文錯誤轉成老師看得懂的中文提示
export function aiErrorText(e, Anthropic) {
  const msg = String(e?.error?.error?.message || e?.message || e || '');
  const has = s => msg.toLowerCase().includes(s);
  if (has('credit balance')) return 'AI 判讀未完成：Anthropic 帳號餘額不足。請到 console.anthropic.com 的「Plans & Billing」儲值後，再按一次「AI 判讀並評分」（金鑰不用重填）。';
  if (e instanceof Anthropic.AuthenticationError || has('invalid x-api-key')) return 'AI 判讀未完成：API 金鑰無效或已被刪除，請到「系統設定」重新填寫金鑰。';
  if (e instanceof Anthropic.PermissionDeniedError) return 'AI 判讀未完成：這把金鑰沒有使用權限，請到 console.anthropic.com 確認金鑰所屬的組織與權限。';
  if (e instanceof Anthropic.NotFoundError) return `AI 判讀未完成：此帳號無法使用模型 ${MODEL}，請聯絡系統維護者。`;
  if (e instanceof Anthropic.RateLimitError) return 'AI 判讀未完成：短時間內送出太多請求，請等 1 分鐘後再按一次。';
  if (e?.status === 529 || has('overloaded')) return 'AI 判讀未完成：AI 服務目前忙碌，請稍等幾分鐘後再按一次。';
  if (e instanceof Anthropic.APIConnectionError) return 'AI 判讀未完成：連不上 AI 服務，請檢查網路後再按一次。';
  if (e instanceof Anthropic.InternalServerError) return 'AI 判讀未完成：AI 服務暫時發生問題，請稍後再按一次。';
  if (has('too large') || has('request_too_large')) return 'AI 判讀未完成：圖檔太大，請降低掃描解析度後重新上傳。';
  if (e instanceof Anthropic.BadRequestError) return 'AI 判讀未完成：請求格式有誤，請改用「判讀匯入／修正」，並把以下訊息提供給系統維護者：' + msg;
  return 'AI 判讀未完成，請稍後再試一次。（技術訊息：' + msg + '）';
}

async function call(content, schema) {
  const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm');
  const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true });
  let msg;
  try {
    msg = await client.beta.messages.stream({ model: MODEL, max_tokens: 32000, system: SYSTEM, thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', messages: [{ role: 'user', content }] }).finalMessage();
  } catch (e) {
    throw new Error(aiErrorText(e, Anthropic));
  }
  if (msg.stop_reason === 'refusal') throw new Error('AI 拒絕判讀此內容，請改用「匯入判讀」。');
  if (msg.stop_reason === 'max_tokens') throw new Error('AI 判讀輸出過長而中斷，請再試一次。');
  return JSON.parse(msg.content.find(b => b.type === 'text').text);
}

export async function buildInventory(text) {
  const inv = await call([{ type: 'text', text: '以下是學生繪製概念圖所依據的文本。請精讀三遍後輸出：\n- root：文本的主概念；concepts：文本中所有重要概念（id 用文本原詞、精簡；aliases 為同義寫法），標示 core/support；\n- reference：依此文本可畫出的『標準概念圖』中，有效關係數、階層數、交叉連結數、例子數，以及 items 逐條列出；\n- cross_hints：2～3 個可引導學生發現交叉連結的提示問句；\n- analogy：一個適合八年級學生、幫助理解本文核心抽象概念的生活類比（一兩句話）。\n\n【文本】\n' + text }], INVENTORY_SCHEMA);
  const r = inv.reference || {};
  inv.standard_score = (r.relations || 0) + 5 * (r.levels || 0) + 10 * (r.cross_links || 0) + (r.examples || 0);
  return inv;
}

export async function analyzeMap(text, inventory, jpegBase64, { collab, members, seat }) {
  const task = collab
    ? '這是一張『小組協作概念圖』，每位組員用自己的顏色繪製。組員與顏色如下：\n' + members.map(m => `- 座號 ${m.seat}：${m.color}`).join('\n') +
      '\n請依筆跡顏色判定每個節點文字、每條連線、每個例子是誰畫的，owner 填該生座號（無法判定填空字串）。若某位組員用自己的顏色把別人寫的節點『圈起來』，請把他的座號列入該節點的 rings。'
    : `這是座號 ${seat} 學生的『個人概念圖』（單一顏色）。owner 一律填 "${seat}"，rings 給空陣列。`;
  return call([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
    { type: 'text', text: `【文本】\n${text}\n\n【文本概念清單（節點 id 請優先使用這些名稱）】\n${(inventory.concepts || []).map(c => c.id).join('、')}\n\n【任務】${task}\n請依系統規則輸出判讀 JSON。` }], MAP_SCHEMA);
}
