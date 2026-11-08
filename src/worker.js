// Metro Master Sync API：存檔快照存在 R2（讀寫與列表皆為強一致，跨裝置立即可見）。
const PREFIX = 's/';
// 自動儲存的歷史版本：v/<存檔 id>/<時間戳 base36，固定 9 碼以便排序>
const VERSION_PREFIX = 'v/';
const VERSION_MIN_GAP = 15 * 60 * 1000; // 兩個歷史版本至少相隔 15 分鐘
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 保留規則：[多久以內, 每個區間保留一份的區間長度]；超過最後一段的刪除
const VERSION_TIERS = [
  [2 * HOUR, 0], // 2 小時內：全部保留
  [DAY, HOUR], // 24 小時內：每小時一份
  [30 * DAY, DAY], // 30 天內：每天一份
  [180 * DAY, 7 * DAY], // 180 天內：每週一份
];
const PENDING_KEY = 'meta/pending';
const GAME_KEY_PREFIX = 'transit-planner:';
const TOKEN_TTL = 365 * 24 * 3600; // 書籤內的 token 一年有效；改密碼即全部失效
const MAX_BODY = 20 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/play' || url.pathname.startsWith('/play/')) return proxyGame(request, env, url);
    if (url.pathname === '/mms.user.js') return userscript(url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: err.message || '伺服器錯誤' }, status, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;
  const allowed = origin && (origin === env.GAME_ORIGIN || origin === self);
  return allowed
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/login/game' && method === 'POST') return loginWithGame(request, env);
  if (pathname === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const token = await requireAuth(request, env);

  if (pathname === '/api/me' && method === 'GET') return json({ ok: true });
  // 以 Bearer token 換發 /play/ 用的 Cookie（舊登入狀態也能直接進我的網域版）
  if (pathname === '/api/session' && method === 'POST') {
    const exp = Number(token.split('.')[0]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, exp - Math.floor(Date.now() / 1000)) });
  }

  if (pathname === '/api/snapshots') {
    if (method === 'GET') return listSnapshots(env);
    if (method === 'POST') return createSnapshot(request, env);
  }

  const v = pathname.match(/^\/api\/snapshots\/([a-z0-9-]{1,40})\/versions(?:\/([a-z0-9]{9})(\/restore)?)?$/);
  if (v) {
    const [, id, vid, restore] = v;
    if (!vid && method === 'GET') return listVersions(env, id);
    if (vid && !restore && method === 'GET') return getVersion(env, id, vid);
    if (vid && restore && method === 'POST') return restoreVersion(request, env, id, vid);
  }

  const m = pathname.match(/^\/api\/snapshots\/([a-z0-9-]{1,40})$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return getSnapshot(env, id);
    if (method === 'PATCH') return updateSnapshot(request, env, id);
    if (method === 'PUT') return replaceSnapshot(request, env, id);
    if (method === 'DELETE') {
      await env.SAVES.delete(PREFIX + id);
      await deleteVersions(env, id);
      const pending = await readPending(env);
      if (pending?.id === id) await env.SAVES.delete(PENDING_KEY);
      return json({ ok: true });
    }
  }

  if (pathname === '/api/pending') {
    if (method === 'GET') return json({ pending: await readPending(env) });
    if (method === 'PUT') {
      const { id } = await readJson(request);
      const obj = await env.SAVES.head(PREFIX + id);
      if (!obj) throw new HttpError(404, '找不到這個存檔');
      const pending = { id, name: obj.customMetadata?.name || '', at: Date.now() };
      await env.SAVES.put(PENDING_KEY, JSON.stringify(pending));
      return json({ pending });
    }
    if (method === 'DELETE') {
      await env.SAVES.delete(PENDING_KEY);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, '找不到 API');
}

// ---------- 認證 ----------

async function hmacKey(env) {
  if (!env.APP_PASSWORD) throw new HttpError(500, '尚未設定 APP_PASSWORD');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('mms1|' + env.APP_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function login(request, env) {
  const { password } = await readJson(request);
  const key = await hmacKey(env);
  // 以 HMAC 比對避免時序攻擊
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode('pw|' + String(password ?? ''))),
    crypto.subtle.sign('HMAC', key, enc.encode('pw|' + env.APP_PASSWORD)),
  ]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, '密碼錯誤');
  }
  return issueToken(env);
}

async function issueToken(env, extra = {}) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode('token|' + exp));
  const token = `${exp}.${b64url(sig)}`;
  return json({ token, exp, ...extra }, 200, { 'Set-Cookie': sessionCookie(token, TOKEN_TTL) });
}

// ---------- 遊戲帳號登入：驗證遊戲（Firebase Auth）發給玩家的 ID token ----------

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: null, until: 0 };

async function firebaseKey(kid) {
  const now = Date.now();
  if (!jwksCache.keys || now > jwksCache.until || !jwksCache.keys[kid]) {
    const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new HttpError(502, '無法取得 Google 驗證金鑰');
    const maxAge = Number((res.headers.get('Cache-Control') || '').match(/max-age=(\d+)/)?.[1]) || 3600;
    const { keys } = await res.json();
    jwksCache = { keys: Object.fromEntries(keys.map((k) => [k.kid, k])), until: now + maxAge * 1000 };
  }
  const jwk = jwksCache.keys[kid];
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function verifyFirebaseIdToken(env, idToken) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(500, '尚未設定 FIREBASE_PROJECT_ID');
  const bad = () => new HttpError(401, '遊戲登入資訊無效或已過期，請在遊戲頁重新整理後再試');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw bad();
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw bad();
  }
  if (header.alg !== 'RS256' || !header.kid) throw bad();
  const key = await firebaseKey(header.kid);
  if (!key) throw bad();
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromB64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (
    !ok ||
    payload.iss !== 'https://securetoken.google.com/' + projectId ||
    payload.aud !== projectId ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    !(payload.exp > now) ||
    !(payload.iat <= now + skew) ||
    !(payload.auth_time <= now + skew) ||
    payload.firebase?.sign_in_provider === 'anonymous'
  ) {
    throw bad();
  }
  return payload;
}

async function loginWithGame(request, env) {
  const { idToken } = await readJson(request);
  const p = await verifyFirebaseIdToken(env, idToken);
  const email = p.email_verified && typeof p.email === 'string' ? p.email.toLowerCase() : '';
  const account = { uid: p.sub, email, name: typeof p.name === 'string' ? p.name : '' };
  const allowed = String(env.ALLOWED_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(p.sub.toLowerCase()) && !(email && allowed.includes(email))) {
    await new Promise((r) => setTimeout(r, 500));
    const who = email ? `${email}（uid ${p.sub}）` : `uid ${p.sub}`;
    throw new HttpError(403, `遊戲帳號 ${who} 沒有使用權限。請把它加進 Worker 的 ALLOWED_ACCOUNTS。`);
  }
  return issueToken(env, { account });
}

const COOKIE = 'mms_session';
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

async function verifyToken(env, token) {
  const [expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), new TextEncoder().encode('token|' + exp));
  } catch {
    return false;
  }
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await verifyToken(env, token))) throw new HttpError(401, '請重新登入');
  return token;
}

// ---------- userscript：在原網站每次開遊戲時自動載入 inject.js ----------

const USERSCRIPT_VERSION = '1.0.0';

function userscript(url) {
  const origin = url.origin;
  const game = 'https://metromaster.huangyouci.com';
  const body = `// ==UserScript==
// @name         Metro Master Sync
// @namespace    ${origin}
// @version      ${USERSCRIPT_VERSION}
// @description  在捷運規劃大師原網站自動載入存檔同步：🚇 按鈕、自動儲存、雲端存檔
// @match        ${game}/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  ${origin}/
// @downloadURL  ${origin}/mms.user.js
// @updateURL    ${origin}/mms.user.js
// ==/UserScript==

// 同步程式本體每次都從 ${origin} 載入最新版，這個腳本本身很少需要更新。
// 用 <script> 標籤載入，讓程式在頁面環境執行（各家 userscript 管理器的執行環境不同）。
(function () {
  if (document.querySelector('script[data-mms-userscript]')) return;
  var s = document.createElement('script');
  s.src = '${origin}/inject.js?mode=auto&t=' + Date.now();
  s.dataset.mmsUserscript = '1';
  (document.head || document.documentElement).appendChild(s);
})();
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

// ---------- /play/：透過本網域執行遊戲 ----------

async function proxyGame(request, env, url) {
  if (url.pathname === '/play') return Response.redirect(url.origin + '/play/' + url.search, 301);
  if (!(await verifyToken(env, readCookie(request, COOKIE)))) {
    return Response.redirect(url.origin + '/?next=play', 302);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });

  const upstream = new URL(url.pathname.slice('/play'.length) + url.search, env.GAME_ORIGIN);
  const res = await fetch(upstream, {
    method: request.method,
    headers: {
      Accept: request.headers.get('Accept') || '*/*',
      'Accept-Language': request.headers.get('Accept-Language') || '',
      'User-Agent': request.headers.get('User-Agent') || '',
    },
    redirect: 'manual',
  });

  const headers = new Headers(res.headers);
  for (const h of ['set-cookie', 'content-security-policy', 'report-to', 'nel', 'alt-svc']) headers.delete(h);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  const loc = headers.get('Location');
  if (loc) {
    const target = new URL(loc, upstream);
    if (target.origin === env.GAME_ORIGIN) headers.set('Location', '/play' + target.pathname + target.search);
  }

  if (!(headers.get('Content-Type') || '').includes('text/html')) {
    return new Response(res.body, { status: res.status, headers });
  }
  // 遊戲頁面：插入同步程式，並避免快取舊版頁面
  headers.delete('content-length');
  headers.set('Cache-Control', 'no-store');
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        // 隱藏自家推廣廣告的蓋版倒數；遊戲偵測到廣告被隱藏時會直接給獎勵並關閉
        el.append(
          '<style>.promo-sheet{display:none!important}</style>' +
            // 加入主畫面：以全螢幕 App 開啟 /play/（遊戲本身沒有 manifest）。iOS 主畫面圖示只吃 PNG
            '<link rel="manifest" href="/app/manifest.webmanifest">' +
            '<link rel="apple-touch-icon" href="/app/apple-touch-icon.png">' +
            '<meta name="mobile-web-app-capable" content="yes">' +
            '<meta name="apple-mobile-web-app-capable" content="yes">' +
            '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
            '<meta name="apple-mobile-web-app-title" content="捷運規劃大師">' +
            '<script src="/core.js"></script><script src="/inject.js"></script>',
          { html: true },
        );
      },
    })
    .transform(new Response(res.body, { status: res.status, headers }));
}

// ---------- 存檔 ----------

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, '存檔太大');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'JSON 格式錯誤');
  }
}

function validateData(data) {
  if (!data || data.version !== 1 || typeof data.keys !== 'object' || !data.keys) {
    throw new HttpError(400, '存檔格式錯誤（需要 {version:1, keys:{...}}）');
  }
  const entries = Object.entries(data.keys);
  if (entries.length === 0) throw new HttpError(400, '存檔是空的');
  for (const [k, v] of entries) {
    if (!k.startsWith(GAME_KEY_PREFIX) || typeof v !== 'string') throw new HttpError(400, `不合法的存檔項目：${k}`);
  }
  return { version: 1, keys: Object.fromEntries(entries) };
}

// 從遊戲的 summary 欄位整理出簡短摘要（城市、計劃、車站數、路線數、運量）
// 遊戲有兩代鍵名：
// - 第 5 版：psummary.<計劃 id>[@城市]，計劃順序記在 planlist[@城市] 的 ids
// - 舊版：summary[~N][@城市]（升級後遊戲會刪掉）；挑戰都是 qsummary.<slug>[@城市]
function summarize(keys) {
  const PFX = 'transit-planner:v4:';
  const slots = [];
  const order = {};
  const planIndex = (city, id) => {
    if (!(city in order)) {
      try {
        order[city] = JSON.parse(keys[PFX + (city === 'taipei' ? 'planlist' : 'planlist@' + city)] || '{}').ids || [];
      } catch {
        order[city] = [];
      }
    }
    const i = order[city].indexOf(id);
    return i < 0 ? '?' : i + 1;
  };
  const re = /^transit-planner:v4:(?:summary(?:~(\d{1,6}))?|psummary\.([A-Za-z0-9_-]{1,64})|qsummary\.([a-z0-9]{1,16}))(?:@([a-z0-9_-]{1,40}))?$/;
  for (const [k, v] of Object.entries(keys)) {
    const m = re.exec(k);
    if (!m) continue;
    const city = m[4] || 'taipei';
    try {
      const s = JSON.parse(v);
      slots.push({
        c: city,
        p: m[3] ? 'q:' + m[3] : m[2] ? planIndex(city, m[2]) : Number(m[1] || 1),
        // 計劃 id：編號會因刪除、移動計劃而改變，管理介面的成長圖表用 id 辨識同一份計劃
        ...(m[2] ? { i: m[2] } : {}),
        st: s.stations | 0,
        l: s.lines | 0,
        r: Math.round(s.riders || 0),
      });
    } catch {}
  }
  slots.sort((a, b) => b.st - a.st);
  return {
    city: keys[PFX + 'city'] || null,
    slots: slots.slice(0, 12),
  };
}

const clip = (s, n) => String(s ?? '').slice(0, n);
// 摘要存在 R2 customMetadata（全部欄位合計上限 2KB），超過 SUMMARY_MAX 就從站數最少的計劃開始捨棄，
// 不直接截斷字串，避免存進壞掉的 JSON
const SUMMARY_MAX = 1200;
function summaryJson(keys) {
  const s = summarize(keys);
  let out = JSON.stringify(s);
  while (out.length > SUMMARY_MAX && s.slots.length) {
    s.slots.pop();
    out = JSON.stringify(s);
  }
  return out;
}
// 內容版本：新建是 1，每次覆寫內容 +1；改名、釘選不變。這個功能之前建立的存檔沒有，視為 0
const revOf = (m) => Number(m?.rev) || 0;
// R2 條件寫入失敗（物件剛被別的請求改過）時重試的次數
const WRITE_RETRIES = 3;

function toMeta(obj) {
  const m = obj.customMetadata || {};
  let summary = null;
  try {
    summary = m.summary ? JSON.parse(m.summary) : null;
  } catch {}
  return {
    id: obj.key.slice(PREFIX.length),
    name: m.name || '',
    device: m.device || '',
    source: m.source || '',
    createdAt: Number(m.createdAt) || obj.uploaded?.getTime() || 0,
    updatedAt: Number(m.updatedAt) || Number(m.createdAt) || obj.uploaded?.getTime() || 0,
    pinned: m.pinned === '1',
    rev: revOf(m),
    size: obj.size,
    keyCount: Number(m.keyCount) || 0,
    summary,
  };
}

async function listSnapshots(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.SAVES.list({ prefix: PREFIX, include: ['customMetadata'], cursor, limit: 1000 });
    for (const obj of page.objects) items.push(toMeta(obj));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return json({ snapshots: items, pending: await readPending(env) });
}

async function createSnapshot(request, env) {
  const body = await readJson(request);
  const data = validateData(body.data);
  const now = Date.now();
  const id = now.toString(36) + '-' + crypto.randomUUID().slice(0, 8);
  const meta = {
    name: clip(body.name, 80),
    device: clip(body.device, 60),
    source: clip(body.source, 20),
    createdAt: String(now),
    updatedAt: String(now),
    pinned: body.pinned ? '1' : '0',
    rev: '1',
    keyCount: String(Object.keys(data.keys).length),
    summary: summaryJson(data.keys),
  };
  const text = JSON.stringify(data);
  const obj = await env.SAVES.put(PREFIX + id, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: meta,
  });
  return json({ snapshot: toMeta({ key: PREFIX + id, size: obj.size, customMetadata: meta }) }, 201);
}

// 覆寫存檔內容（自動儲存用），保留建立時間、來源與釘選。
// 帶 baseRev 時，雲端版本不同就回 409，不覆寫（避免兩台裝置互相蓋掉）；沒帶時照舊直接覆寫。
// 寫入用 etag 條件寫入，讀取到寫入之間被別的請求改過就重讀再試。
async function replaceSnapshot(request, env, id) {
  const body = await readJson(request);
  const data = validateData(body.data);
  const text = JSON.stringify(data);
  const checkRev = body.baseRev !== undefined && body.baseRev !== null;
  for (let i = 0; i < WRITE_RETRIES; i++) {
    const old = await env.SAVES.get(PREFIX + id);
    if (!old) throw new HttpError(404, '找不到這個存檔');
    const rev = revOf(old.customMetadata);
    if (checkRev && Number(body.baseRev) !== rev) {
      await old.arrayBuffer();
      return json({ error: '雲端存檔已被其他裝置更新', conflict: true, snapshot: toMeta(old) }, 409);
    }
    await archiveVersion(env, id, old);
    const meta = {
      ...old.customMetadata,
      rev: String(rev + 1),
      updatedAt: String(Date.now()),
      keyCount: String(Object.keys(data.keys).length),
      summary: summaryJson(data.keys),
    };
    if (typeof body.name === 'string') meta.name = clip(body.name, 80);
    if (typeof body.device === 'string') meta.device = clip(body.device, 60);
    const obj = await env.SAVES.put(PREFIX + id, text, {
      onlyIf: { etagMatches: old.etag },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: meta,
    });
    if (obj) return json({ snapshot: toMeta({ key: PREFIX + id, size: obj.size, customMetadata: meta }) });
  }
  throw new HttpError(409, '雲端存檔正在被其他裝置更新，請稍後再試');
}

// ---------- 歷史版本 ----------

const versionKey = (id, at) => `${VERSION_PREFIX}${id}/${at.toString(36).padStart(9, '0')}`;

async function listVersionObjects(env, id) {
  const out = [];
  let cursor;
  do {
    const page = await env.SAVES.list({ prefix: `${VERSION_PREFIX}${id}/`, include: ['customMetadata'], cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const versionAt = (obj) => parseInt(obj.key.slice(obj.key.lastIndexOf('/') + 1), 36);

// 依保留規則挑出要留下的版本（times 由新到舊）
function keepVersions(times, now) {
  const keep = new Set();
  const seen = new Set();
  for (const t of times) {
    const age = now - t;
    const tier = VERSION_TIERS.findIndex(([within]) => age < within);
    if (tier < 0) continue;
    const step = VERSION_TIERS[tier][1];
    if (!step) {
      keep.add(t);
      continue;
    }
    // 同一區間只留最新的一份
    const bucket = tier + ':' + Math.floor(t / step);
    if (!seen.has(bucket)) {
      seen.add(bucket);
      keep.add(t);
    }
  }
  return keep;
}

// 自動儲存覆寫前，把舊內容存成歷史版本，並清掉超出保留規則的版本
async function archiveVersion(env, id, old) {
  const at = Number(old.customMetadata?.updatedAt) || old.uploaded.getTime();
  const objs = await listVersionObjects(env, id);
  const times = objs.map(versionAt).sort((a, b) => b - a);
  const now = Date.now();
  if (!times.length || at - times[0] >= VERSION_MIN_GAP) {
    await env.SAVES.put(versionKey(id, at), await old.arrayBuffer(), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        device: old.customMetadata?.device || '',
        keyCount: old.customMetadata?.keyCount || '0',
        summary: old.customMetadata?.summary || '',
      },
    });
    times.unshift(at);
  } else {
    // 距離上一個版本太近，不另存；讀掉內容以釋放連線
    await old.arrayBuffer();
  }
  const keep = keepVersions(times, now);
  const drop = objs.filter((o) => !keep.has(versionAt(o))).map((o) => o.key);
  for (let i = 0; i < drop.length; i += 1000) await env.SAVES.delete(drop.slice(i, i + 1000));
}

async function deleteVersions(env, id) {
  const keys = (await listVersionObjects(env, id)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) await env.SAVES.delete(keys.slice(i, i + 1000));
}

function versionMeta(obj) {
  const m = obj.customMetadata || {};
  let summary = null;
  try {
    summary = m.summary ? JSON.parse(m.summary) : null;
  } catch {}
  const at = versionAt(obj);
  return { vid: obj.key.slice(obj.key.lastIndexOf('/') + 1), at, device: m.device || '', keyCount: Number(m.keyCount) || 0, size: obj.size, summary };
}

async function listVersions(env, id) {
  if (!(await env.SAVES.head(PREFIX + id))) throw new HttpError(404, '找不到這個存檔');
  const versions = (await listVersionObjects(env, id)).map(versionMeta).sort((a, b) => b.at - a.at);
  return json({ versions });
}

async function getVersion(env, id, vid) {
  const obj = await env.SAVES.get(`${VERSION_PREFIX}${id}/${vid}`);
  if (!obj) throw new HttpError(404, '找不到這個歷史版本');
  return json({ version: versionMeta(obj), data: await obj.json() });
}

// 把歷史版本複製成一筆新的手動存檔，原本的自動儲存不受影響
async function restoreVersion(request, env, id, vid) {
  const body = await readJson(request).catch(() => ({}));
  const [src, obj] = await Promise.all([env.SAVES.head(PREFIX + id), env.SAVES.get(`${VERSION_PREFIX}${id}/${vid}`)]);
  if (!obj) throw new HttpError(404, '找不到這個歷史版本');
  // 名稱由瀏覽器依本地時區組好傳來；沒傳時用 UTC 時間
  const stamp = new Date(versionAt(obj)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const fallback = `${src?.customMetadata?.name || '自動儲存'}（${stamp} 版本）`;
  const now = Date.now();
  const newId = now.toString(36) + '-' + crypto.randomUUID().slice(0, 8);
  const meta = {
    name: clip(typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : fallback, 80),
    device: obj.customMetadata?.device || '',
    source: 'restore',
    createdAt: String(now),
    updatedAt: String(now),
    pinned: '0',
    rev: '1',
    keyCount: obj.customMetadata?.keyCount || '0',
    summary: obj.customMetadata?.summary || '',
  };
  const saved = await env.SAVES.put(PREFIX + newId, await obj.arrayBuffer(), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: meta,
  });
  return json({ snapshot: toMeta({ key: PREFIX + newId, size: saved.size, customMetadata: meta }) }, 201);
}

async function getSnapshot(env, id) {
  const obj = await env.SAVES.get(PREFIX + id);
  if (!obj) throw new HttpError(404, '找不到這個存檔');
  const data = await obj.json();
  return json({ snapshot: toMeta(obj), data });
}

async function updateSnapshot(request, env, id) {
  const body = await readJson(request);
  // R2 無法單獨改 metadata，只能連內容一起重寫；用條件寫入，避免把同時寫入的新內容蓋回舊的
  for (let i = 0; i < WRITE_RETRIES; i++) {
    const obj = await env.SAVES.get(PREFIX + id);
    if (!obj) throw new HttpError(404, '找不到這個存檔');
    const meta = { ...obj.customMetadata };
    if (typeof body.name === 'string') meta.name = clip(body.name, 80);
    if (typeof body.pinned === 'boolean') meta.pinned = body.pinned ? '1' : '0';
    const saved = await env.SAVES.put(PREFIX + id, await obj.arrayBuffer(), {
      onlyIf: { etagMatches: obj.etag },
      httpMetadata: obj.httpMetadata,
      customMetadata: meta,
    });
    if (saved) return json({ snapshot: toMeta({ key: PREFIX + id, size: saved.size, customMetadata: meta }) });
  }
  throw new HttpError(409, '存檔正在被其他裝置更新，請稍後再試');
}

async function readPending(env) {
  const obj = await env.SAVES.get(PENDING_KEY);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}
