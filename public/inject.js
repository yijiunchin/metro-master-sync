// 遊戲頁上的存檔同步面板。
// - 原網站 + 書籤：每點一次開／關面板。
// - 原網站 + userscript（inject.js?mode=auto）：每次開遊戲自動載入，顯示浮動按鈕並自動儲存。
// - /play/ 我的網域版：由 worker 直接插入頁面，顯示浮動按鈕。
(() => {
  const SCRIPT_URL = new URL(document.currentScript?.src || location.href);
  const SELF = SCRIPT_URL.origin;
  const cfg = window.__MMS || {};
  const API = cfg.api || SELF;
  const GAME_HOST = 'metromaster.huangyouci.com';
  const onPlay = location.origin === SELF && location.pathname.startsWith('/play/');
  // 由 userscript 載入：在原網站也像 /play/ 一樣常駐
  const viaUserscript = !onPlay && SCRIPT_URL.searchParams.get('mode') === 'auto';
  // 常駐模式：有浮動按鈕、自動儲存，並配合其他分頁的匯入
  const resident = onPlay || viaUserscript;

  if (viaUserscript && location.hostname !== GAME_HOST) return;

  if (location.hostname !== GAME_HOST && !onPlay) {
    if (confirm('請在「捷運規劃大師」遊戲頁面使用這個書籤。\n要前往遊戲網站嗎？')) location.href = 'https://' + GAME_HOST + '/';
    return;
  }

  // 「解鎖全部（ALL ACCESS）」開關：勾了就在存檔/自動儲存時把商店紀錄補成 owned。
  // 開關存在本機（每台裝置、每個網域分開），預設關閉，是非破壞性的——關掉不會移除已補上的全解。
  const UNLOCK_ON_KEY = 'mms:unlock-all';

  // 讀本機進度；勾了「解鎖全部」就一併把 transit-planner:v4:unlock 補成 owned
  function readGame(C) {
    const data = C.readLocal();
    if (C.get(UNLOCK_ON_KEY) === '1') C.applyUnlockAll(data);
    return data;
  }

  // 就地把本機進度的商店紀錄補成全解（只改 unlock 這一個 key，不碰其他；已在匯入時不處理）
  function patchLocalUnlock(C) {
    if (C.isFrozen()) return true;
    const data = C.readLocal();
    if (C.unlockOwned(data)) return true; // 已經是全解
    C.applyUnlockAll(data);
    C.set(C.UNLOCK_KEY, data.keys[C.UNLOCK_KEY]);
    return false;
  }

  // 先裝上背景執行緒的監聽，勾選「固定顯示計算監測面板」之前的進度也記得到
  const monitor = createMonitor();

  if (window.MMSCore) start();
  else {
    const s = document.createElement('script');
    s.src = API + '/core.js?t=' + Date.now();
    s.onload = start;
    s.onerror = () => alert('無法載入同步程式，請檢查網路連線。');
    document.head.appendChild(s);
  }

  function start() {
    const C = window.MMSCore;
    const getToken = () => cfg.token || C.storedToken();
    if (monitor.pinned()) {
      if (document.body) monitor.show();
      else document.addEventListener('DOMContentLoaded', () => monitor.show());
    }

    if (!resident) {
      // 第一次點書籤後就在這個分頁啟動自動儲存（重新整理頁面後要再點一次書籤）
      const open = () => {
        if (!window.__MMS_AUTO__) {
          window.__MMS_AUTO__ = createAutoSave(C, getToken, () => !cfg.token && C.set(C.TOKEN_KEY, null));
          window.__MMS_AUTO__.run();
        }
        togglePanel(C, getToken, window.__MMS_AUTO__);
      };
      if (getToken() || document.getElementById('mms-host')) return open();
      // 書籤沒有內建 token：用遊戲帳號登入換發
      C.loginWithGame(API).then(
        open,
        (err) => alert('無法用遊戲帳號登入：' + err.message + '\n\n也可以到 ' + API + ' 用密碼登入後，建立內含登入資訊的書籤。'),
      );
      return;
    }

    // ----- 常駐模式：/play/ 我的網域版，或原網站 + userscript -----
    if (window.__MMS_PLAY__) return;
    window.__MMS_PLAY__ = true;

    // 原網站沒有本站的登入 Cookie，用遊戲帳號換發 token（失敗時等使用者按 🚇 再試）
    let loginError = null;
    const ensureLogin = async () => {
      if (onPlay || getToken()) return true;
      try {
        await C.loginWithGame(API);
        loginError = null;
        auto.run();
        return true;
      } catch (err) {
        loginError = err.message;
        return false;
      }
    };

    // 管理介面或其他分頁匯入存檔時，配合暫停寫入並重新載入
    C.channel?.addEventListener('message', (e) => {
      const { type } = e.data || {};
      if (type === 'flush') C.flushGame();
      else if (type === 'freeze') C.freezeWrites();
      else if (type === 'unfreeze') C.unfreezeWrites();
      else if (type === 'reload') location.reload();
    });
    // 分頁在背景時可能收不到訊息，回到前景時再檢查一次
    const markAtLoad = localStorage.getItem(C.IMPORT_MARK);
    const checkImported = () => {
      if (localStorage.getItem(C.IMPORT_MARK) !== markAtLoad) {
        C.freezeWrites();
        location.reload();
      }
    };
    window.addEventListener('storage', (e) => e.key === C.IMPORT_MARK && checkImported());
    document.addEventListener('visibilitychange', () => !document.hidden && checkImported(), true);

    // 原網站：token 失效時清掉，下次用遊戲帳號重新換發
    const dropToken = () => !onPlay && !cfg.token && C.set(C.TOKEN_KEY, null);
    const auto = createAutoSave(C, getToken, dropToken);
    window.__MMS_AUTO__ = auto;

    const addFab = () => {
      const fab = document.createElement('button');
      fab.id = 'mms-fab';
      fab.type = 'button';
      fab.textContent = '🚇';
      fab.title = '存檔同步';
      fab.setAttribute('aria-label', '存檔同步');
      fab.style.cssText =
        'position:fixed;z-index:2147483646;left:12px;top:calc(env(safe-area-inset-top) + 64px);width:40px;height:40px;' +
        'border-radius:50%;border:0;background:rgba(255,255,255,.92);box-shadow:0 2px 10px rgba(0,0,0,.25);font-size:20px;' +
        'line-height:40px;padding:0;cursor:pointer;touch-action:manipulation;';
      fab.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!document.getElementById('mms-host')) {
          const ok = await ensureLogin();
          mark();
          if (!ok) return alert('無法用遊戲帳號登入：' + loginError);
        }
        togglePanel(C, getToken, auto);
      });
      document.body.appendChild(fab);
      // 還沒登入時按鈕半透明，提示需要先在遊戲裡登入帳號
      const mark = () => {
        const ok = onPlay || !!getToken();
        fab.style.opacity = ok ? '1' : '.55';
        fab.title = ok ? '存檔同步' : '存檔同步（尚未登入：' + (loginError || '請在遊戲裡登入帳號') + '）';
      };
      mark();
      ensureLogin().then(mark);
      document.addEventListener('visibilitychange', () => !document.hidden && !getToken() && ensureLogin().then(mark));
    };
    // 手機開啟時的「下載 App」對話框：自動選「在網頁玩」
    const skipGetApp = () => {
      const check = () => document.querySelector('.get-app .play-web')?.click();
      check();
      new MutationObserver(check).observe(document.body, { childList: true });
    };
    const onBody = () => {
      addFab();
      if (onPlay) skipGetApp();
    };
    if (document.body) onBody();
    else document.addEventListener('DOMContentLoaded', onBody);
  }

  // ---------- 計算監測 ----------
  // 遊戲把模擬（stepWorker）和正式統計（「計算中」，透過 officialPort 跑在同一個 Worker）放在背景執行緒。
  // 這裡包裝 Worker.prototype.postMessage，只讀取雙方往來的訊息；遊戲載入後才裝上也能運作。
  // 「加速計算」會把遊戲送出的工作比例（budget.duty）改成 1；遊戲預設依操作狀態給 15%～100%。
  function createMonitor() {
    if (window.__MMS_MON__) return window.__MMS_MON__;
    const PIN_KEY = 'mms:monitor-on';
    const now = () => performance.now();
    const S = { duty: null, port: null, turbo: false, seq: null, rounds: 0, startAt: 0, lastAt: 0, gaps: [], done: [], stepOut: new Map(), stepLat: [] };
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const fmt = (ms) => (ms == null ? '—' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' 秒');
    // 省電模式會再減半（7.5%／15%／25%／50%），和一般模式的數值重疊，所以只標一般模式的意思
    const DUTY = { 0.15: '操作中', 0.3: '剛操作過', 0.5: '閒置', 1: '背景／首頁' };

    const onIn = (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.kind === 'off' && d.reply) {
        const r = d.reply;
        if (r.kind === 'progress') {
          const t = now();
          if (S.seq !== r.seq) Object.assign(S, { seq: r.seq, rounds: 0, startAt: t, lastAt: t, gaps: [] });
          else if (S.lastAt) S.gaps.push(t - S.lastAt), S.gaps.length > 20 && S.gaps.shift();
          S.rounds = r.rounds;
          S.lastAt = t;
        } else if (r.kind === 'solved' || r.kind === 'error') {
          if (r.kind === 'solved') {
            const o = r.official || {};
            S.done.unshift({ at: Date.now(), rounds: o.rounds, by: o.by, ms: r.ms, wallMs: r.wallMs });
            S.done.length = Math.min(S.done.length, 3);
          }
          S.seq = null;
        }
      } else if (d.kind === 'step' && S.stepOut.has(d.seq)) {
        S.stepLat.push(now() - S.stepOut.get(d.seq));
        S.stepOut.delete(d.seq);
        S.stepLat.length > 30 && S.stepLat.shift();
      }
    };
    const onOut = (d) => {
      if (!d || typeof d !== 'object') return d;
      if (d.kind === 'step' && d.seq != null) {
        S.stepOut.set(d.seq, now());
        // 被丟掉的請求不會有回覆，避免越積越多
        if (S.stepOut.size > 50) S.stepOut.delete(S.stepOut.keys().next().value);
      }
      if (d.kind === 'off' && d.msg?.kind === 'budget') {
        S.duty = d.msg.duty;
        if (S.turbo) return { ...d, msg: { ...d.msg, duty: 1 } };
      }
      return d;
    };

    const seen = new WeakSet();
    const post = Worker.prototype.postMessage;
    if (typeof Worker !== 'undefined') {
      Worker.prototype.postMessage = function (d, ...rest) {
        try {
          if (d?.kind === 'off') S.port = this;
          if (!seen.has(this)) {
            seen.add(this);
            this.addEventListener('message', (e) => {
              try {
                onIn(e.data);
              } catch {}
            });
          }
          d = onOut(d);
        } catch {}
        return post.call(this, d, ...rest);
      };
    }

    // 主執行緒卡頓：每 100ms 打點，記錄最近的最長延遲
    let jank = 0;
    let tick = null;

    let host = null;
    let timer = null;
    const setTurbo = (on) => {
      S.turbo = on;
      if (S.port) post.call(S.port, { kind: 'off', msg: { kind: 'budget', duty: on ? 1 : (S.duty ?? 0.5) } });
      render();
    };

    function render() {
      if (!host) return;
      const r = host.shadowRoot;
      const t = now();
      const L = [];
      L.push('工作比例：' + (S.duty == null ? '等待遊戲送出' : (DUTY[S.duty] ? DUTY[S.duty] + ' ' : '') + +(S.duty * 100).toFixed(1) + '%') + (S.turbo ? ' → 加速 100%' : ''));
      if (S.seq != null) {
        const per = avg(S.gaps);
        const idle = t - S.lastAt;
        const stuck = per && idle > Math.max(60000, per * 6);
        L.push(`正式統計：第 ${S.rounds} 回合（上限 600）`);
        L.push(`  已算 ${fmt(t - S.startAt)}，每回合約 ${fmt(per)}`);
        L.push(`  距上次進度 ${fmt(idle)}  ${stuck ? '⚠️ 可能卡住' : '✅ 有在推進'}`);
      } else L.push('正式統計：目前沒有在算');
      for (const d of S.done) {
        const at = new Date(d.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        L.push(`  ✔ ${at} 算完：${d.rounds ?? '?'} 回合，運算 ${fmt(d.ms)}／經過 ${fmt(d.wallMs)}`);
      }
      L.push(`模擬回應：最近 ${fmt(S.stepLat[S.stepLat.length - 1])}，平均 ${fmt(avg(S.stepLat))}`);
      L.push(`主執行緒延遲：${fmt(jank)}`);
      r.querySelector('.t').textContent = L.join('\n');
      r.querySelector('button').textContent = S.turbo ? '關閉加速' : '加速計算';
      r.querySelector('button').classList.toggle('on', S.turbo);
    }

    function show() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'mms-mon';
      host.style.cssText = 'position:fixed;z-index:2147483645;left:12px;top:calc(env(safe-area-inset-top) + 112px);pointer-events:none;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
  .box { background: rgba(20,22,26,.86); color: #eef1f4; font: 11.5px/1.5 ui-monospace, Menlo, Consolas, monospace; padding: 7px 9px; border-radius: 8px; max-width: min(320px, calc(100vw - 24px)); }
  .h { display: flex; align-items: center; gap: 8px; font: 600 12px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; margin-bottom: 3px; }
  .h span { flex: 1; }
  .t { white-space: pre-wrap; }
  button { pointer-events: auto; font: 12px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; border: 0; border-radius: 6px; padding: 2px 8px; cursor: pointer; background: #e8ecf0; color: #1b1f24; }
  button.on { background: #f0a020; }
</style><div class="box"><div class="h"><span>🚇 計算監測</span><button type="button" title="把背景計算的工作比例固定成 100%；重新整理頁面就恢復遊戲預設">加速計算</button></div><div class="t"></div></div>`;
      root.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        setTurbo(!S.turbo);
      });
      document.body.appendChild(host);
      let last = now();
      tick = setInterval(() => {
        const t = now();
        jank = Math.max(jank * 0.9, t - last - 100);
        last = t;
      }, 100);
      timer = setInterval(render, 500);
      render();
    }

    function hide() {
      clearInterval(timer);
      clearInterval(tick);
      host?.remove();
      host = null;
    }

    const pinned = () => {
      try {
        return localStorage.getItem(PIN_KEY) === '1';
      } catch {
        return false;
      }
    };
    const setPinned = (on) => {
      try {
        on ? localStorage.setItem(PIN_KEY, '1') : localStorage.removeItem(PIN_KEY);
      } catch {}
      on ? show() : hide();
    };

    return (window.__MMS_MON__ = { state: S, show, hide, pinned, setPinned, setTurbo });
  }

  // ---------- 排行榜檢查 ----------
  // 只讀 localStorage：各計劃摘要（可上的榜）、遊戲帳號雲端同步紀錄、這台裝置送上榜的紀錄
  function boardReport() {
    const V4 = 'transit-planner:v4:';
    const get = (k) => {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    };
    const listOf = (city) => (get(V4 + 'planlist' + (city === 'taipei' ? '' : '@' + city)) || {}).ids || [];
    const sums = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = k && /^transit-planner:v4:(p|q)summary\.([A-Za-z0-9_-]+)(?:@([a-z0-9_-]+))?$/.exec(k);
      if (m) sums.push({ kind: m[1], id: m[2], city: m[3] || 'taipei', s: get(k) || {} });
    }
    // 遊戲模型版本：取摘要中最新的那個（格式 YYMMDD-HHMM，字串比較即可）
    const model = sums.reduce((a, x) => (typeof x.s.model === 'string' && x.s.model > a ? x.s.model : a), '');
    const label = (kind, id, city) => {
      if (kind === 'q') return `${city}・挑戰 ${id}`;
      const no = listOf(city).indexOf(id) + 1;
      return `${city}・計劃 ${no || '?'}`;
    };
    const plans = sums
      .map(({ kind, id, city, s }) => {
        const ratio = Number.isFinite(s.ratio) ? Math.round(s.ratio * 1000) : null;
        const ok = !!(s.official && s.key && s.model === model);
        return {
          label: label(kind, id, city),
          stations: s.stations,
          lines: s.lines,
          riders: s.riders,
          ratio,
          ok,
          boards: kind === 'q' ? '挑戰榜' : !ok ? '（還不能上）' : ratio != null && ratio >= 1000 ? '日運量、收支平衡' : '只有日運量',
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    // 同步單位 p:<城市>:<計劃 id> 或 q:<城市>:<挑戰>
    const unitLabel = (u) => {
      const m = /^([pq]):([a-z0-9_-]+):(.+)$/.exec(u || '');
      return m ? label(m[1], m[3], m[2]) : u || '—';
    };
    const acc = get(V4 + 'account');
    const units = acc?.units ? Object.entries(acc.units).map(([u, v]) => ({ label: unitLabel(u), rev: v.rev, stations: v.stations })) : null;
    const b = get('transit-planner-account:board');
    const ledger = Object.entries(b?.docs || {})
      .map(([id, d]) => ({ id, ...d, from: d.unit ? unitLabel(d.unit) : '—' }))
      .sort((x, y) => (y.at || 0) - (x.at || 0));
    const wait = Object.entries(b?.wait || {}).map(([id, t]) => ({ id, until: t }));
    return { plans, units, ledger, wait };
  }

  // 自動儲存：進度有變動時定期上傳，切到背景時也存一次。
  // 一直更新同一筆 source=auto-save 的雲端存檔，不會每次新增。
  function createAutoSave(C, getToken, onUnauthorized) {
    const ON_KEY = 'mms:autosave-on';
    const LAST_KEY = 'mms:autosave-last';
    const INTERVAL = 30 * 1000;
    const api = C.createApi(API, getToken, onUnauthorized);
    const listeners = new Set();
    let running = null;

    const auto = {
      enabled: () => C.get(ON_KEY) !== '0',
      setEnabled(on) {
        C.set(ON_KEY, on ? '1' : '0');
        if (on) auto.run();
        notify();
      },
      lastAt: () => Number(C.get(LAST_KEY)) || 0,
      error: null,
      onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      run: () => (running ??= save().finally(() => (running = null))),
    };
    const notify = () => listeners.forEach((fn) => fn());

    async function save() {
      if (!auto.enabled() || C.isFrozen() || !getToken()) return;
      const data = readGame(C);
      if (!C.hasProgress(data)) return;
      const hash = C.hashData(data);
      if (hash === C.get(C.AUTOSAVE_HASH_KEY)) return;
      const body = { name: C.current()?.name || '', device: C.device(), data };
      const text = JSON.stringify(body);
      // 頁面關閉時仍要送出；keepalive 有 64KB 上限
      const keepalive = text.length < 60000;
      try {
        let res = null;
        const id = C.get(C.AUTOSAVE_ID_KEY);
        if (id) {
          res = await api('/api/snapshots/' + id, { method: 'PUT', body: text, keepalive }).catch((err) => {
            if (/找不到/.test(err.message)) return null; // 已被刪除就另開一筆
            throw err;
          });
        }
        if (!res) {
          res = await api('/api/snapshots', {
            method: 'POST',
            body: JSON.stringify({ ...body, source: 'auto-save' }),
            keepalive,
          });
          C.set(C.AUTOSAVE_ID_KEY, res.snapshot.id);
        }
        // 匯入進行中就不記錄，避免把舊進度當成已儲存
        if (C.isFrozen()) return;
        C.set(C.AUTOSAVE_HASH_KEY, hash);
        C.set(LAST_KEY, String(Date.now()));
        auto.error = null;
      } catch (err) {
        auto.error = err.message;
        console.warn('[MMS] 自動儲存失敗', err);
      } finally {
        notify();
      }
    }

    setInterval(() => !document.hidden && auto.run(), INTERVAL);
    // 等遊戲自己在 visibilitychange 寫完 localStorage 再讀
    document.addEventListener('visibilitychange', () => document.hidden && setTimeout(() => auto.run(), 0));
    window.addEventListener('pagehide', () => auto.run());
    return auto;
  }

  function togglePanel(C, getToken, auto) {
    const existing = document.getElementById('mms-host');
    if (existing) {
      existing.remove();
      return;
    }
    // 遊戲帳號換發的 token 失效時清掉，下次點書籤會重新登入
    const api = C.createApi(API, getToken, () => !cfg.token && !onPlay && C.set(C.TOKEN_KEY, null));
    // 開管理介面時帶上 token（放在 # 後面，不會送到伺服器），管理頁讀取後會立刻從網址移除
    const manageUrl = API + '/' + (onPlay || !getToken() ? '' : '#token=' + encodeURIComponent(getToken()));

    const host = document.createElement('div');
    host.id = 'mms-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    // 不讓遊戲的快捷鍵吃掉輸入框的按鍵
    for (const t of ['keydown', 'keyup', 'keypress', 'wheel']) host.addEventListener(t, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
  .panel { position: fixed; top: max(12px, env(safe-area-inset-top)); right: 12px; left: 12px; margin-left: auto; max-width: 420px;
    max-height: calc(100dvh - 24px); display: flex; flex-direction: column; background: #fff; color: #1b1f24;
    border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.25); overflow: hidden; font-size: 14px; user-select: text; -webkit-user-select: text; }
  @media (prefers-color-scheme: dark) { .panel { background: #1c2128; color: #e6edf3; } .item, .save { border-color: #30363d !important; } input { background:#0d1117; color:#e6edf3; border-color:#30363d !important; } .muted { color:#8b949e !important; } }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid rgba(127,127,127,.2); }
  header b { flex: 1; font-size: 15px; }
  .body { overflow: auto; padding: 12px 14px 16px; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; background: #e8ecf0; color: #1b1f24; touch-action: manipulation; }
  button.primary { background: #1a73e8; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .x { background: transparent; font-size: 18px; padding: 4px 8px; color: inherit; }
  .save { display: flex; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid #e3e6ea; margin-bottom: 8px; }
  input { flex: 1; min-width: 0; font: inherit; font-size: 16px; padding: 7px 10px; border: 1px solid #cfd6dd; border-radius: 8px; }
  .pending { background: #fff4ce; color: #5c4400; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; display: flex; gap: 8px; align-items: center; }
  .pending span { flex: 1; }
  .item { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid #eef0f2; }
  .item .info { flex: 1; min-width: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: #6a737d; font-size: 12px; margin-top: 2px; }
  .status { min-height: 18px; font-size: 13px; margin: 6px 0; }
  .err { color: #d1242f; }
  a { color: #1a73e8; }
  .auto { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid #e3e6ea; margin-bottom: 4px; cursor: pointer; }
  .auto input { flex: none; width: 18px; height: 18px; margin: 0; }
  .auto .muted { margin: 0 0 0 auto; }
  .unlock { display: flex; align-items: center; gap: 6px; padding-top: 10px; border-top: 1px solid #e3e6ea; margin-top: 8px; cursor: pointer; }
  .unlock input { flex: none; width: 18px; height: 18px; margin: 0; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #ddf4ff; color: #0550ae; margin-left: 4px; }
  .item button + button { margin-left: 4px; }
  .picker { border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .picker .ph { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .picker .ph b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pp-note { font-size: 12px; color: #6a737d; margin-bottom: 8px; }
  .pp-row { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #6a737d; margin-bottom: 8px; }
  .pp-row select { font: inherit; font-size: 14px; padding: 6px 8px; border-radius: 8px; border: 1px solid #cfd6dd; max-width: 100%; color: inherit; background: transparent; }
  .pp-actions { display: flex; align-items: center; gap: 8px; }
  .pp-status { font-size: 13px; color: #d1242f; }
  .unlock + .unlock { border-top: 0; margin-top: 0; }
  .tools { display: flex; gap: 8px; margin-top: 10px; }
  .board { border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
  .board h4 { margin: 10px 0 4px; font-size: 13px; }
  .board h4:first-child { margin-top: 0; }
  .board .wrap { overflow-x: auto; }
  .board table { border-collapse: collapse; width: 100%; font-size: 12px; white-space: nowrap; }
  .board th, .board td { text-align: left; padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
  .board th { font-weight: 600; color: #6a737d; }
  .board td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .board .note { font-size: 12px; color: #6a737d; margin-top: 8px; line-height: 1.5; }
</style>
<div class="backdrop"></div>
<div class="panel" role="dialog" aria-label="Metro Master Sync">
  <header><b>🚇 存檔同步</b><a href="${manageUrl}" target="_blank" rel="noopener">管理介面</a><button class="x" data-act="close" aria-label="關閉">✕</button></header>
  <div class="body">
    <div class="save">
      <input id="name" placeholder="存檔名稱（可留空）" maxlength="80" />
      <button class="primary" data-act="save">儲存目前進度</button>
    </div>
    ${auto ? '<label class="auto"><input type="checkbox" id="auto" /> 自動儲存<span class="muted" id="auto-state"></span></label>' : ''}
    <label class="unlock"><input type="checkbox" id="unlock-all" /> 解鎖全部功能（計劃 4/5・自訂顏色・區間 3）</label>
    <label class="unlock"><input type="checkbox" id="monitor" /> 固定顯示計算監測面板</label>
    <div class="tools"><button data-act="board">排行榜檢查</button></div>
    <div id="board" class="board" hidden></div>
    <div class="status" id="status"></div>
    <div id="pending"></div>
    <div id="picker" class="picker" hidden></div>
    <div id="list"><div class="muted">載入中…</div></div>
  </div>
</div>`;
    document.body.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const fmtTime = (t) =>
      new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const sourceTag = { 'auto-save': '自動儲存', 'auto-backup': '匯入前備份' };
    const describe = (s) => {
      const top = s.summary?.slots?.[0];
      return top ? `${top.c}・${top.st} 站 ${top.l} 線` : `${s.keyCount} 項`;
    };
    const setStatus = (msg, isErr) => {
      const el = $('#status');
      el.textContent = msg || '';
      el.className = 'status' + (isErr ? ' err' : '');
    };

    let snapshots = [];
    let pending = null;

    function render() {
      $('#pending').innerHTML = pending
        ? `<div class="pending"><span>待匯入：<b>${esc(pending.name || '未命名存檔')}</b></span><button class="primary" data-act="load" data-id="${esc(pending.id)}">載入</button><button data-act="pick" data-id="${esc(pending.id)}">選計劃</button><button data-act="clear-pending">略過</button></div>`
        : '';
      $('#list').innerHTML = snapshots.length
        ? snapshots
            .slice(0, 50)
            .map(
              (s) => `<div class="item"><div class="info">
            <div class="name">${esc(s.name || '未命名存檔')}${s.pinned ? '<span class="tag">釘選</span>' : ''}${sourceTag[s.source] ? `<span class="tag">${sourceTag[s.source]}</span>` : ''}</div>
            <div class="muted">${fmtTime(s.updatedAt || s.createdAt)}・${esc(s.device || '?')}・${esc(describe(s))}</div>
          </div><button data-act="pick" data-id="${esc(s.id)}" title="只匯入其中一份計劃">選計劃</button><button data-act="load" data-id="${esc(s.id)}">載入</button></div>`,
            )
            .join('')
        : '<div class="muted">雲端還沒有存檔，先按「儲存目前進度」吧。</div>';
    }

    async function refresh() {
      if (!getToken()) {
        $('#list').innerHTML = '';
        setStatus('尚未登入，請先到管理介面登入。', true);
        return;
      }
      try {
        const r = await api('/api/snapshots');
        snapshots = r.snapshots;
        pending = r.pending;
        render();
      } catch (e) {
        $('#list').innerHTML = '';
        const hint = /登入/.test(e.message) ? (onPlay ? '（請到管理介面重新登入）' : '（請到管理介面重新建立書籤）') : '';
        setStatus('讀取雲端存檔失敗：' + e.message + hint, true);
      }
    }

    async function saveCurrent(name, source = 'manual') {
      C.flushGame();
      const data = readGame(C);
      if (!C.hasProgress(data)) throw new Error('這個瀏覽器目前沒有遊戲進度');
      const res = await api('/api/snapshots', {
        method: 'POST',
        body: JSON.stringify({ name, device: C.device(), source, data }),
      });
      if (source === 'manual') C.setCurrent(res.snapshot);
      return res;
    }

    async function load(id) {
      const meta = snapshots.find((s) => s.id === id) || (pending?.id === id ? pending : null);
      const label = meta?.name || '未命名存檔';
      if (!confirm(`要用「${label}」覆蓋這個瀏覽器目前的遊戲進度嗎？\n（目前進度會先自動備份到雲端）`)) return;
      setStatus('下載存檔中…');
      const { data, snapshot } = await api('/api/snapshots/' + id);
      C.flushGame();
      if (C.hasProgress(C.readLocal())) {
        setStatus('備份目前進度中…');
        await saveCurrent('匯入前自動備份', 'auto-backup');
      }
      if (pending?.id === id) await api('/api/pending', { method: 'DELETE' }).catch(() => {});
      setStatus('寫入中，即將重新載入遊戲…');
      C.freezeWrites();
      // 通知同網域其他開著遊戲的分頁（/play/ 或 userscript 常駐的原網站分頁）
      C.broadcast('freeze');
      await C.sleep(150);
      try {
        C.writeLocal(data, snapshot);
      } catch (err) {
        C.unfreezeWrites();
        C.broadcast('unfreeze');
        throw err;
      }
      C.broadcast('reload');
      location.reload();
    }

    // 只匯入一份計劃：覆蓋本機同城市的其中一份，不新增計劃
    async function openPicker(id) {
      const meta = snapshots.find((s) => s.id === id) || (pending?.id === id ? pending : null);
      const box = $('#picker');
      box.hidden = false;
      box.innerHTML = `<div class="ph"><b>從「${esc(meta?.name || '未命名存檔')}」選計劃</b><button class="x" data-act="close-picker" aria-label="關閉">✕</button></div><div class="pp">載入中…</div>`;
      const { data } = await api('/api/snapshots/' + id);
      C.flushGame();
      C.renderPlanPicker(box.querySelector('.pp'), data, async (src, target) => {
        C.flushGame();
        if (C.hasProgress(C.readLocal())) {
          setStatus('備份目前進度中…');
          await saveCurrent('匯入前自動備份', 'auto-backup');
        }
        if (pending?.id === id) await api('/api/pending', { method: 'DELETE' }).catch(() => {});
        setStatus('寫入中，即將重新載入遊戲…');
        C.freezeWrites();
        C.broadcast('freeze');
        await C.sleep(150);
        try {
          C.importPlan(data, src, target);
        } catch (err) {
          C.unfreezeWrites();
          C.broadcast('unfreeze');
          throw err;
        }
        C.broadcast('reload');
        location.reload();
      });
      box.scrollIntoView({ block: 'nearest' });
    }

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn && e.target.classList.contains('backdrop')) return host.remove();
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') return host.remove();
      btn.disabled = true;
      try {
        if (act === 'save') {
          setStatus('儲存中…');
          await saveCurrent($('#name').value.trim());
          setStatus('✓ 已儲存到雲端');
          await refresh();
        } else if (act === 'load') {
          await load(btn.dataset.id);
        } else if (act === 'pick') {
          await openPicker(btn.dataset.id);
        } else if (act === 'close-picker') {
          $('#picker').hidden = true;
        } else if (act === 'board') {
          const box = $('#board');
          box.hidden = !box.hidden;
          if (!box.hidden) renderBoard(box);
        } else if (act === 'board-refresh') {
          renderBoard($('#board'));
        } else if (act === 'clear-pending') {
          await api('/api/pending', { method: 'DELETE' });
          pending = null;
          render();
        }
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    $('#name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('[data-act="save"]').click();
    });

    $('#name').value = C.current()?.name || '';

    // 排行榜檢查：只讀本機資料，不會送出或修改任何東西
    function renderBoard(box) {
      const r = boardReport();
      const n = (v) => (v == null ? '—' : esc(v));
      const table = (head, rows) =>
        `<div class="wrap"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table></div>`;
      const tr = (cells) => `<tr>${cells.map((c) => (typeof c === 'object' ? `<td class="n">${c.n}</td>` : `<td>${c}</td>`)).join('')}</tr>`;
      const wan = (v) => (v ? (v / 1e4).toFixed(1) + ' 萬' : '—');
      let html = '<h4>① 各計劃可上的榜</h4>';
      html += r.plans.length
        ? table(
            ['計劃', '站', '線', '日運量', '收支比', '統計', '可上的榜'],
            r.plans.map((p) =>
              tr([esc(p.label), { n: n(p.stations) }, { n: n(p.lines) }, { n: wan(p.riders) }, { n: p.ratio == null ? '—' : (p.ratio / 10).toFixed(1) + '%' }, p.ok ? '✅' : '❌ 未算完', esc(p.boards)]),
            ),
          )
        : '<div class="muted">沒有計劃摘要</div>';
      html += '<h4>② 遊戲雲端同步紀錄</h4>';
      html += r.units
        ? table(
            ['計劃', '雲端版本', '站'],
            r.units.map((u) => tr([esc(u.label), { n: n(u.rev) }, { n: n(u.stations) }])),
          )
        : '<div class="muted">沒有同步紀錄：遊戲沒有登入帳號，不會上榜</div>';
      html += '<h4>③ 這台裝置送上榜的成績</h4>';
      html += r.ledger.length
        ? table(
            ['來源計劃', '站', '線', '分數', '送出時間'],
            r.ledger.map((d) => tr([esc(d.from), { n: n(d.stations) }, { n: n(d.lines) }, { n: n(d.score) }, d.at ? fmtTime(d.at) : '—'])),
          )
        : '<div class="muted">沒有紀錄</div>';
      if (r.wait.length) html += `<div class="note">被拒絕、等待重送：${r.wait.map((w) => fmtTime(w.until) + ' 後').join('、')}</div>`;
      html += `<div class="note">收支比 ≥ 100% 才能上「收支平衡」榜；每個榜只保留你最好的一份。上榜不是即時的：遊戲在同步時才送出（改完約 10 分鐘，或回到首頁），同一個榜每小時最多送一次。</div>
        <div class="tools"><button data-act="board-refresh">重新整理</button></div>`;
      box.innerHTML = html;
    }
    const monBox = $('#monitor');
    monBox.checked = monitor.pinned();
    monBox.addEventListener('change', () => monitor.setPinned(monBox.checked));

    if (auto) {
      const box = $('#auto');
      const renderAuto = () => {
        if (!host.isConnected) return off();
        box.checked = auto.enabled();
        const last = auto.lastAt();
        $('#auto-state').textContent = auto.error
          ? '失敗：' + auto.error
          : auto.enabled() && last
            ? '上次 ' + new Date(last).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
            : '';
      };
      const off = auto.onChange(renderAuto);
      box.addEventListener('change', () => auto.setEnabled(box.checked));
      renderAuto();
    }

    // 「解鎖全部（ALL ACCESS）」：勾了就在存檔/自動儲存時補上 owned；勾上時也立刻補本機，重新載入後生效
    const unlockBox = $('#unlock-all');
    if (unlockBox) {
      unlockBox.checked = C.get(UNLOCK_ON_KEY) === '1';
      unlockBox.addEventListener('change', () => {
        C.set(UNLOCK_ON_KEY, unlockBox.checked ? '1' : '0');
        if (unlockBox.checked) {
          try {
            const already = patchLocalUnlock(C);
            setStatus(already ? '這筆進度已是全解' : '已補上全解，重新載入遊戲畫面後生效（之後自動儲存也會帶上）');
          } catch (e) {
            setStatus('補上全解失敗：' + e.message, true);
          }
        } else {
          setStatus('已停止強制全解（已補上的全解保留、不移除）');
        }
      });
    }

    refresh();
  }
})();
