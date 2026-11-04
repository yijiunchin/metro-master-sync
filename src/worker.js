// Metro Master Sync API：存檔快照存在 R2（讀寫與列表皆為強一致，跨裝置立即可見）。
const PREFIX = 's/';
const PENDING_KEY = 'meta/pending';
const GAME_KEY_PREFIX = 'transit-planner:';
const TOKEN_TTL = 365 * 24 * 3600; // 書籤內的 token 一年有效；改密碼即全部失效
const MAX_BODY = 20 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/play' || url.pathname.startsWith('/play/')) return proxyGame(request, env, url);
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

  const m = pathname.match(/^\/api\/snapshots\/([a-z0-9-]{1,40})$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return getSnapshot(env, id);
    if (method === 'PATCH') return updateSnapshot(request, env, id);
    if (method === 'PUT') return replaceSnapshot(request, env, id);
    if (method === 'DELETE') {
      await env.SAVES.delete(PREFIX + id);
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

// 從遊戲的 summary 欄位整理出簡短摘要（城市、方案、車站數、路線數、運量）
function summarize(keys) {
  const slots = [];
  const re = /^transit-planner:v4:(?:summary(?:~(\d{1,2}))?|qsummary\.([a-z0-9]{1,16}))(?:@([a-z0-9_-]{1,40}))?$/;
  for (const [k, v] of Object.entries(keys)) {
    const m = re.exec(k);
    if (!m) continue;
    try {
      const s = JSON.parse(v);
      slots.push({
        c: m[3] || 'taipei',
        p: m[2] ? 'q:' + m[2] : Number(m[1] || 1),
        st: s.stations | 0,
        l: s.lines | 0,
        r: Math.round(s.riders || 0),
      });
    } catch {}
  }
  slots.sort((a, b) => b.st - a.st);
  return {
    city: keys['transit-planner:v4:city'] || null,
    slots: slots.slice(0, 12),
  };
}

const clip = (s, n) => String(s ?? '').slice(0, n);

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
  const summary = summarize(data.keys);
  const meta = {
    name: clip(body.name, 80),
    device: clip(body.device, 60),
    source: clip(body.source, 20),
    createdAt: String(now),
    updatedAt: String(now),
    pinned: body.pinned ? '1' : '0',
    keyCount: String(Object.keys(data.keys).length),
    summary: JSON.stringify(summary).slice(0, 1200),
  };
  const text = JSON.stringify(data);
  const obj = await env.SAVES.put(PREFIX + id, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: meta,
  });
  return json({ snapshot: toMeta({ key: PREFIX + id, size: obj.size, customMetadata: meta }) }, 201);
}

// 覆寫存檔內容（自動儲存用），保留建立時間、來源與釘選
async function replaceSnapshot(request, env, id) {
  const body = await readJson(request);
  const data = validateData(body.data);
  const old = await env.SAVES.head(PREFIX + id);
  if (!old) throw new HttpError(404, '找不到這個存檔');
  const meta = {
    ...old.customMetadata,
    updatedAt: String(Date.now()),
    keyCount: String(Object.keys(data.keys).length),
    summary: JSON.stringify(summarize(data.keys)).slice(0, 1200),
  };
  if (typeof body.name === 'string') meta.name = clip(body.name, 80);
  if (typeof body.device === 'string') meta.device = clip(body.device, 60);
  const obj = await env.SAVES.put(PREFIX + id, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: meta,
  });
  return json({ snapshot: toMeta({ key: PREFIX + id, size: obj.size, customMetadata: meta }) });
}

async function getSnapshot(env, id) {
  const obj = await env.SAVES.get(PREFIX + id);
  if (!obj) throw new HttpError(404, '找不到這個存檔');
  const data = await obj.json();
  return json({ snapshot: toMeta(obj), data });
}

async function updateSnapshot(request, env, id) {
  const body = await readJson(request);
  const obj = await env.SAVES.get(PREFIX + id);
  if (!obj) throw new HttpError(404, '找不到這個存檔');
  const meta = { ...obj.customMetadata };
  if (typeof body.name === 'string') meta.name = clip(body.name, 80);
  if (typeof body.pinned === 'boolean') meta.pinned = body.pinned ? '1' : '0';
  // R2 無法單獨改 metadata，只能連內容一起重寫
  const saved = await env.SAVES.put(PREFIX + id, await obj.arrayBuffer(), {
    httpMetadata: obj.httpMetadata,
    customMetadata: meta,
  });
  return json({ snapshot: toMeta({ key: PREFIX + id, size: saved.size, customMetadata: meta }) });
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
