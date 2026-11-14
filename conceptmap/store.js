// 資料層：Firebase（正式）與本機試用（?local=1，資料只存在這台裝置的瀏覽器）兩種實作，介面相同。
export const ROLES = ['student', 'teacher', 'manager', 'admin'];
export const ROLE_LABEL = { student: '學生', teacher: '教師', manager: '管理者', admin: 'admin（最高管理者）' };
export const rank = u => ROLES.indexOf(u?.role || 'student');
export const ADMIN_USERNAME = 'admin';
const DOMAIN = '@conceptmap.example.com';   // Firebase 需要 email 格式；學生只需記帳號
const emailOf = u => u.toLowerCase() + DOMAIN;
export const memberKey = (school, cls, seat) => [school, cls, seat].map(x => String(x || '').trim()).join('|');

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const firebaseConfig = {
  apiKey: 'AIzaSyDl298TgTC1tzxgw1ffGuUWakXmb_7OUW0', authDomain: 'cp-tools-2c4d2.firebaseapp.com', projectId: 'cp-tools-2c4d2',
  storageBucket: 'cp-tools-2c4d2.firebasestorage.app', messagingSenderId: '407584130600', appId: '1:407584130600:web:889052a6ec031f58c6d71d',
};
const AUTH_MSG = {
  'auth/email-already-in-use': '這個帳號已有人使用，請換一個。', 'auth/invalid-credential': '帳號或密碼不正確。',
  'auth/wrong-password': '帳號或密碼不正確。', 'auth/user-not-found': '帳號或密碼不正確。', 'auth/weak-password': '密碼至少 6 個字元。',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試。', 'auth/network-request-failed': '網路連線不穩，請檢查網路後再試。',
  'auth/operation-not-allowed': '系統尚未開啟帳號功能：請管理者到 Firebase 主控台 → Authentication → Sign-in method 啟用「電子郵件/密碼」。',
  'auth/configuration-not-found': '系統尚未開啟帳號功能：請管理者到 Firebase 主控台 → Authentication 按「開始使用」，並啟用「電子郵件/密碼」。',
  'auth/requires-recent-login': '為了安全，請先登出再登入一次，然後再修改密碼。',
  'permission-denied': '權限不足，或資料庫安全規則尚未更新（請管理者部署 firestore.rules）。',
};
export const friendly = e => AUTH_MSG[e?.code] || (e?.code ? `操作未完成（${e.code}），請再試一次。` : (e?.message || '操作未完成，請再試一次。'));

// ------------------------------------------------------------------ Firebase
async function firebaseStore() {
  const V = 'https://www.gstatic.com/firebasejs/10.12.0/';
  const [{ initializeApp }, A, F] = await Promise.all([import(V + 'firebase-app.js'), import(V + 'firebase-auth.js'), import(V + 'firebase-firestore.js')]);
  const app = initializeApp(firebaseConfig), auth = A.getAuth(app), db = F.getFirestore(app);
  const col = n => F.collection(db, 'cm_' + n), ref = (n, id) => F.doc(db, 'cm_' + n, id);
  const data = s => s.exists() ? { id: s.id, ...s.data() } : null;
  const all = async q => (await F.getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
  const profile = async uid => data(await F.getDoc(ref('users', uid)));
  return {
    mode: 'firebase',
    onAuth(cb) {
      A.onAuthStateChanged(auth, async fu => {
        if (!fu) return cb(null);
        try {
          let p = null;   // 剛註冊時個人資料可能還在寫入，稍等再判定
          for (let i = 0; i < 8 && !(p = await profile(fu.uid)); i++) await new Promise(r => setTimeout(r, 500));
          if (!p) { await A.signOut(auth); return cb(null, '這個帳號已被管理者停用。'); }
          cb({ uid: fu.uid, ...p });
        } catch (e) { cb(null, friendly(e)); }
      });
    },
    async register(f) {
      const cred = await A.createUserWithEmailAndPassword(auth, emailOf(f.username), f.password);
      const role = f.username.toLowerCase() === ADMIN_USERNAME ? 'admin' : 'student';
      await F.setDoc(ref('users', cred.user.uid), { username: f.username.toLowerCase(), name: f.name || '', role, school: f.school || '',
        cls: f.cls || '', seat: f.seat || '', createdAt: Date.now() });
    },
    login: (u, p) => A.signInWithEmailAndPassword(auth, emailOf(u), p),
    logout: () => A.signOut(auth),
    updateProfile: (uid, d) => F.updateDoc(ref('users', uid), d),
    async changePassword(oldPw, newPw) {
      await A.reauthenticateWithCredential(auth.currentUser, A.EmailAuthProvider.credential(auth.currentUser.email, oldPw));
      await A.updatePassword(auth.currentUser, newPw);
    },
    async listSubs(u) {
      if (rank(u) >= 1) return (await all(col('subs'))).sort((a, b) => b.createdAt - a.createdAt);
      const mine = await all(F.query(col('subs'), F.where('createdBy', '==', u.uid)));
      const k = memberKey(u.school, u.cls, u.seat);
      const grp = u.seat ? await all(F.query(col('subs'), F.where('memberKeys', 'array-contains', k))) : [];
      const m = new Map([...mine, ...grp].map(x => [x.id, x]));
      return [...m.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    getSub: async id => data(await F.getDoc(ref('subs', id))),
    createSub: async d => (await F.addDoc(col('subs'), d)).id,
    updateSub: (id, d) => F.updateDoc(ref('subs', id), d),
    deleteSub: id => F.deleteDoc(ref('subs', id)),
    putImage: (id, d) => F.setDoc(ref('images', id), d),
    getImage: async id => data(await F.getDoc(ref('images', id))),
    putText: (id, d) => F.setDoc(ref('texts', id), d),
    getText: async id => data(await F.getDoc(ref('texts', id))),
    listTexts: () => all(col('texts')),
    getAnalysis: async k => data(await F.getDoc(ref('analysis', k))),
    putAnalysis: (k, d) => F.setDoc(ref('analysis', k), d),
    listAnalysis: () => all(col('analysis')),
    getSettings: async () => data(await F.getDoc(ref('settings', 'main'))) || {},
    putSettings: d => F.setDoc(ref('settings', 'main'), d),
    listUsers: () => all(col('users')),
    setRole: (uid, role) => F.updateDoc(ref('users', uid), { role }),
    deleteUser: uid => F.deleteDoc(ref('users', uid)),
  };
}

// ------------------------------------------------------------------ 本機試用（IndexedDB）
async function localStore() {
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open('conceptmap-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = (mode, fn) => new Promise((res, rej) => { const t = idb.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); });
  const get = k => tx('readonly', s => s.get(k)), put = (k, v) => tx('readwrite', s => s.put(v, k)), del = k => tx('readwrite', s => s.delete(k));
  const keys = p => tx('readonly', s => s.getAllKeys(IDBKeyRange.bound(p, p + '￿')));
  const list = async p => Promise.all((await keys(p + '/')).map(async k => ({ id: k.slice(p.length + 1), ...(await get(k)) })));
  const one = async (p, id) => { const v = await get(p + '/' + id); return v ? { id, ...v } : null; };
  let listener = () => {};
  const current = async () => { const uid = sessionStorage.getItem('cm_uid'); const p = uid && await one('users', uid); return p ? { uid, ...p } : null; };
  const fire = async () => listener(await current());
  const err = code => Object.assign(new Error(code), { code });
  return {
    mode: 'local',
    onAuth(cb) { listener = cb; fire(); },
    async register(f) {
      const uid = 'u_' + f.username.toLowerCase();
      if (await get('users/' + uid)) throw err('auth/email-already-in-use');
      await put('users/' + uid, { username: f.username.toLowerCase(), name: f.name || '', role: f.username.toLowerCase() === ADMIN_USERNAME ? 'admin' : 'student',
        school: f.school || '', cls: f.cls || '', seat: f.seat || '', createdAt: Date.now(), pw: await sha256Hex(f.password) });
      sessionStorage.setItem('cm_uid', uid); await fire();
    },
    async login(u, p) {
      const uid = 'u_' + u.toLowerCase(), d = await get('users/' + uid);
      if (!d || d.pw !== await sha256Hex(p)) throw err('auth/invalid-credential');
      sessionStorage.setItem('cm_uid', uid); await fire();
    },
    async logout() { sessionStorage.removeItem('cm_uid'); await fire(); },
    async updateProfile(uid, d) { await put('users/' + uid, { ...(await get('users/' + uid)), ...d }); },
    async changePassword(o, n) { const u = await current(), d = await get('users/' + u.uid); if (d.pw !== await sha256Hex(o)) throw err('auth/invalid-credential'); await put('users/' + u.uid, { ...d, pw: await sha256Hex(n) }); },
    async listSubs(u) {
      const k = memberKey(u.school, u.cls, u.seat);
      return (await list('subs')).filter(s => rank(u) >= 1 || s.createdBy === u.uid || (u.seat && (s.memberKeys || []).includes(k))).sort((a, b) => b.createdAt - a.createdAt);
    },
    getSub: id => one('subs', id),
    async createSub(d) { const id = 's' + Date.now().toString(36); await put('subs/' + id, d); return id; },
    async updateSub(id, d) { await put('subs/' + id, { ...(await get('subs/' + id)), ...d }); },
    deleteSub: id => del('subs/' + id),
    putImage: (id, d) => put('images/' + id, d), getImage: id => one('images', id),
    putText: (id, d) => put('texts/' + id, d), getText: id => one('texts', id), listTexts: () => list('texts'),
    getAnalysis: k => one('analysis', k), putAnalysis: (k, d) => put('analysis/' + k, d), listAnalysis: () => list('analysis'),
    getSettings: async () => (await get('settings/main')) || {}, putSettings: d => put('settings/main', d),
    listUsers: async () => (await list('users')).map(({ pw, ...u }) => u),
    async setRole(uid, role) { await put('users/' + uid, { ...(await get('users/' + uid)), role }); },
    deleteUser: uid => del('users/' + uid),
  };
}

export const isLocal = new URLSearchParams(location.search).has('local');
export const openStore = () => isLocal ? localStore() : firebaseStore();
