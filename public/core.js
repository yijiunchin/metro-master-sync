// 共用的存檔讀寫邏輯：書籤面板（原網站）、/play/ 我的網域版、管理介面都用這份。
(() => {
  if (window.MMSCore) return;

  const PFX = 'transit-planner:';
  // 這些 key 屬於各裝置自己的設定，不同步
  const LOCAL_ONLY = new Set(['transit-planner:v4:lang', 'transit-planner:house-ad-last']);
  // 匯入時更新這個標記，讓其他開著遊戲的分頁知道要重新載入
  const IMPORT_MARK = 'mms:import-at';
  const TOKEN_KEY = 'mms:token';
  // 目前進度對應的雲端存檔 {id, name, source}，用來預設存檔名稱
  const CURRENT_KEY = 'mms:current';
  // 自動儲存寫入的雲端存檔 id，以及上次自動儲存時的進度雜湊
  const AUTOSAVE_ID_KEY = 'mms:autosave-id';
  const AUTOSAVE_HASH_KEY = 'mms:autosave-hash';

  const isStatsCache = (k) => k.startsWith(PFX + 'v4:') && /^q?stats[~.@]|^q?stats$/.test(k.slice(19));
  const syncable = (k) => k.startsWith(PFX) && !LOCAL_ONLY.has(k);

  const proto = Storage.prototype;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  let frozen = false;

  // 擋住遊戲寫入 localStorage（例如重新整理前 visibilitychange 觸發的存檔）
  function freezeWrites() {
    if (frozen) return;
    frozen = true;
    const blocked = (store, k) => store === localStorage && String(k).startsWith(PFX);
    proto.setItem = function (k, v) {
      if (blocked(this, k)) return;
      return origSet.call(this, k, v);
    };
    proto.removeItem = function (k) {
      if (blocked(this, k)) return;
      return origRemove.call(this, k);
    };
  }

  const isFrozen = () => frozen;

  function unfreezeWrites() {
    if (!frozen) return;
    frozen = false;
    proto.setItem = origSet;
    proto.removeItem = origRemove;
  }

  // 模擬切到背景，讓遊戲把記憶體中的最新進度寫入 localStorage（不在遊戲頁時無作用）
  function flushGame() {
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    } catch (e) {
      console.warn('[MMS] flush', e);
    } finally {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    }
  }

  function readLocal() {
    const keys = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !syncable(k) || isStatsCache(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) keys[k] = v;
    }
    return { version: 1, keys };
  }

  // 只有解鎖紀錄、沒有任何存檔時不算有進度
  const hasProgress = (data) => Object.keys(data.keys).some((k) => /^transit-planner:v4:(?:broken\d?\.)?q?save/.test(k));

  // 進度雜湊（與 key 順序無關），用來判斷自動儲存是否需要上傳
  function hashData(data) {
    const text = JSON.stringify(Object.keys(data.keys).sort().map((k) => [k, data.keys[k]]));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return text.length + ':' + (h >>> 0).toString(36);
  }

  const get = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const set = (k, v) => {
    try {
      v === null ? origRemove.call(localStorage, k) : origSet.call(localStorage, k, v);
    } catch {}
  };

  function current() {
    try {
      return JSON.parse(get(CURRENT_KEY)) || null;
    } catch {
      return null;
    }
  }

  function setCurrent(meta) {
    set(CURRENT_KEY, meta ? JSON.stringify({ id: meta.id, name: meta.name || '', source: meta.source || '' }) : null);
  }

  // 以快照覆寫本機遊戲資料；失敗時還原原本內容。
  // meta 是來源存檔的資訊：載入自動儲存的存檔就接續更新它，否則之後另開一筆自動儲存。
  function writeLocal(data, meta) {
    const before = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PFX)) before[k] = localStorage.getItem(k);
    }
    try {
      for (const k of Object.keys(before)) if (syncable(k)) origRemove.call(localStorage, k);
      for (const [k, v] of Object.entries(data.keys)) {
        if (syncable(k) && typeof v === 'string') origSet.call(localStorage, k, v);
      }
      origSet.call(localStorage, IMPORT_MARK, String(Date.now()));
      if (meta) {
        setCurrent(meta);
        set(AUTOSAVE_ID_KEY, meta.source === 'auto-save' ? meta.id : null);
        set(AUTOSAVE_HASH_KEY, hashData(data));
      }
    } catch (err) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PFX)) origRemove.call(localStorage, k);
      }
      for (const [k, v] of Object.entries(before)) origSet.call(localStorage, k, v);
      throw new Error('寫入遊戲存檔失敗，已還原原本進度：' + err.message);
    }
  }

  // 通知同網域其他分頁（/play/ 遊戲頁）
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mms') : null;
  const broadcast = (type) => channel?.postMessage({ type });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function guessDevice() {
    const u = navigator.userAgent;
    const os = /iPhone/.test(u)
      ? 'iPhone'
      : /iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)
        ? 'iPad'
        : /Android/.test(u)
          ? 'Android'
          : /Mac/.test(u)
            ? 'Mac'
            : /Windows/.test(u)
              ? 'Windows'
              : /Linux/.test(u)
                ? 'Linux'
                : '裝置';
    const br = /Edg/.test(u)
      ? 'Edge'
      : /CriOS|Chrome\//.test(u)
        ? 'Chrome'
        : /FxiOS|Firefox\//.test(u)
          ? 'Firefox'
          : /Safari\//.test(u)
            ? 'Safari'
            : '瀏覽器';
    return os + ' · ' + br;
  }

  function device() {
    let name = guessDevice();
    try {
      name = localStorage.getItem('mms:device') || name;
    } catch {}
    return location.hostname === 'metromaster.huangyouci.com' ? name : name + '（我的網域）';
  }

  function storedToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  function createApi(base, getToken, onUnauthorized) {
    return async (path, opts = {}) => {
      const token = getToken();
      const res = await fetch(base + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && path !== '/api/login') onUnauthorized?.();
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      return body;
    };
  }

  window.MMSCore = {
    PFX,
    IMPORT_MARK,
    TOKEN_KEY,
    CURRENT_KEY,
    AUTOSAVE_ID_KEY,
    AUTOSAVE_HASH_KEY,
    freezeWrites,
    unfreezeWrites,
    isFrozen,
    hashData,
    current,
    setCurrent,
    get,
    set,
    flushGame,
    readLocal,
    hasProgress,
    writeLocal,
    channel,
    broadcast,
    sleep,
    device,
    storedToken,
    createApi,
  };
})();
