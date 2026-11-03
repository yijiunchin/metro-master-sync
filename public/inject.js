// 遊戲頁上的存檔同步面板。
// - 原網站：由書籤小工具注入，每點一次開／關面板。
// - /play/ 我的網域版：由 worker 直接插入頁面，顯示浮動按鈕。
(() => {
  const SELF = new URL(document.currentScript?.src || location.href).origin;
  const cfg = window.__MMS || {};
  const API = cfg.api || SELF;
  const GAME_HOST = 'metromaster.huangyouci.com';
  const onPlay = location.origin === SELF && location.pathname.startsWith('/play/');

  if (location.hostname !== GAME_HOST && !onPlay) {
    if (confirm('請在「捷運規劃大師」遊戲頁面使用這個書籤。\n要前往遊戲網站嗎？')) location.href = 'https://' + GAME_HOST + '/';
    return;
  }

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

    if (!onPlay) {
      if (!getToken()) {
        alert('書籤缺少登入資訊，請到 ' + API + ' 登入後重新建立書籤。');
        return;
      }
      togglePanel(C, getToken, null);
      return;
    }

    // ----- /play/ 我的網域版 -----
    if (window.__MMS_PLAY__) return;
    window.__MMS_PLAY__ = true;

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

    const auto = createAutoSave(C, getToken);

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
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel(C, getToken, auto);
      });
      document.body.appendChild(fab);
    };
    // 手機開啟時的「下載 App」對話框：自動選「在網頁玩」
    const skipGetApp = () => {
      const check = () => document.querySelector('.get-app .play-web')?.click();
      check();
      new MutationObserver(check).observe(document.body, { childList: true });
    };
    const onBody = () => {
      addFab();
      skipGetApp();
    };
    if (document.body) onBody();
    else document.addEventListener('DOMContentLoaded', onBody);
  }

  // 自動儲存：進度有變動時定期上傳，切到背景時也存一次。
  // 一直更新同一筆 source=auto-save 的雲端存檔，不會每次新增。
  function createAutoSave(C, getToken) {
    const ON_KEY = 'mms:autosave-on';
    const LAST_KEY = 'mms:autosave-last';
    const INTERVAL = 30 * 1000;
    const api = C.createApi(API, getToken);
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
      const data = C.readLocal();
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
    const api = C.createApi(API, getToken);

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
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #ddf4ff; color: #0550ae; margin-left: 4px; }
</style>
<div class="backdrop"></div>
<div class="panel" role="dialog" aria-label="Metro Master Sync">
  <header><b>🚇 存檔同步</b><a href="${API}/" target="_blank" rel="noopener">管理介面</a><button class="x" data-act="close" aria-label="關閉">✕</button></header>
  <div class="body">
    <div class="save">
      <input id="name" placeholder="存檔名稱（可留空）" maxlength="80" />
      <button class="primary" data-act="save">儲存目前進度</button>
    </div>
    ${auto ? '<label class="auto"><input type="checkbox" id="auto" /> 自動儲存<span class="muted" id="auto-state"></span></label>' : ''}
    <div class="status" id="status"></div>
    <div id="pending"></div>
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
        ? `<div class="pending"><span>待匯入：<b>${esc(pending.name || '未命名存檔')}</b></span><button class="primary" data-act="load" data-id="${esc(pending.id)}">載入</button><button data-act="clear-pending">略過</button></div>`
        : '';
      $('#list').innerHTML = snapshots.length
        ? snapshots
            .slice(0, 50)
            .map(
              (s) => `<div class="item"><div class="info">
            <div class="name">${esc(s.name || '未命名存檔')}${s.pinned ? '<span class="tag">釘選</span>' : ''}${sourceTag[s.source] ? `<span class="tag">${sourceTag[s.source]}</span>` : ''}</div>
            <div class="muted">${fmtTime(s.updatedAt || s.createdAt)}・${esc(s.device || '?')}・${esc(describe(s))}</div>
          </div><button data-act="load" data-id="${esc(s.id)}">載入</button></div>`,
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
      const data = C.readLocal();
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
      if (onPlay) {
        C.broadcast('freeze');
        await C.sleep(150);
      }
      try {
        C.writeLocal(data, snapshot);
      } catch (err) {
        C.unfreezeWrites();
        if (onPlay) C.broadcast('unfreeze');
        throw err;
      }
      if (onPlay) C.broadcast('reload');
      location.reload();
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

    refresh();
  }
})();
