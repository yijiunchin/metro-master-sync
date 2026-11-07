// 管理介面：自動儲存的成長圖表與版本比較
// - 成長圖表只用版本 metadata 裡的摘要（summary.slots：站數 st、線數 l、日運量 r），不用下載存檔內容
// - 版本比較先比摘要；再下載兩個版本的完整內容，解開各計劃的 psave，列出路線、車站的增減
// 計劃以「城市＋計劃 id」辨識：摘要裡的計劃編號（planlist 的順序）會因刪除、移動計劃而改變，不能拿來對應。
// 摘要有計劃 id（slots[].i）之前存的版本，會下載內容在瀏覽器重新解析，結果快取在 localStorage（版本內容不會變）
(() => {
  const C = window.MMSCore;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NS = 'http://www.w3.org/2000/svg';

  const fmtTime = (t) => new Date(t).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtShort = (t, withTime) => {
    const d = new Date(t);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return withTime ? `${md} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : md;
  };
  const fmtFull = (n) => (n == null ? '—' : Math.round(n).toLocaleString('zh-TW'));
  const fmtWan = (n) => (n == null ? '—' : n >= 10000 ? +(n / 10000).toFixed(n >= 1e6 ? 0 : 1) + ' 萬' : fmtFull(n));
  const signed = (d, f = fmtFull) => (d > 0 ? '+' + f(d) : d < 0 ? '−' + f(-d) : '±0');

  const METRICS = [
    { k: 'r', name: '日運量', tick: fmtWan, label: fmtWan },
    { k: 'st', name: '車站數', tick: fmtFull, label: (n) => fmtFull(n) + ' 站' },
    { k: 'l', name: '路線數', tick: fmtFull, label: (n) => fmtFull(n) + ' 線' },
  ];

  // 計劃的辨識 key；舊摘要沒有 id 時回傳 null，要從內容重新解析
  const slotKey = (x) => x.k || (typeof x.p === 'string' && x.p.startsWith('q:') ? x.c + '|' + x.p : x.i ? x.c + '|' + x.i : null);
  const needsData = (p) => !p.slots.length || p.slots.some((x) => !slotKey(x));

  // 從存檔內容算出和 Worker summarize() 相同格式的摘要，並帶上辨識 key
  function summarizeData(data) {
    const moves = {};
    const moved = (city, n) => {
      if (!(city in moves)) {
        try {
          moves[city] = JSON.parse(data.keys['transit-planner:v4:' + (city === 'taipei' ? 'planmove' : 'planmove@' + city)] || '{}');
        } catch {
          moves[city] = {};
        }
      }
      return moves[city][n];
    };
    return C.listPlans(data)
      .filter((p) => p.summary)
      .map((p) => ({
        c: p.city,
        p: p.kind === 'challenge' ? 'q:' + p.slug : p.no ?? '?',
        ...p.summary,
        // 舊版的 save~N 升級後搬到 planmove 記錄的 id，用同一個 key 才接得上
        k: p.city + '|' + (p.kind === 'plan' ? p.id : p.kind === 'challenge' ? 'q:' + p.slug : moved(p.city, p.no) || 'legacy:' + p.no),
      }))
      .sort((a, b) => b.st - a.st);
  }

  const CACHE_PFX = 'mms:vsum1:';
  const cacheGet = (k) => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_PFX + k));
    } catch {
      return null;
    }
  };
  const cacheSet = (k, v) => {
    try {
      localStorage.setItem(CACHE_PFX + k, JSON.stringify(v));
    } catch {}
  };
  const slotName = (x) => `${x.c}・${typeof x.p === 'string' && x.p.startsWith('q:') ? '挑戰 ' + x.p.slice(2) : '計劃 ' + x.p}`;

  // 時間由舊到新的資料點：每個歷史版本＋目前的雲端存檔
  function buildPoints(s, versions) {
    const pts = versions.map((v) => ({ at: v.at, vid: v.vid, device: v.device, slots: v.summary?.slots || [] }));
    pts.push({ at: s.updatedAt || s.createdAt, vid: null, device: s.device, slots: s.summary?.slots || [], current: true });
    pts.sort((a, b) => a.at - b.at);
    return pts;
  }
  const index = (pts) => pts.forEach((p) => (p.by = new Map(p.slots.map((x) => [slotKey(x), x]))));

  // 計劃選單：依目前存檔裡的站數排序，之後才是只出現在舊版本的計劃
  function planOptions(pts) {
    const seen = new Map();
    for (let i = pts.length - 1; i >= 0; i--) for (const x of pts[i].slots) if (!seen.has(slotKey(x))) seen.set(slotKey(x), x);
    return [...seen.values()];
  }

  // 把範圍擴成好讀的刻度
  function niceScale(min, max, count = 3) {
    if (min === max) {
      const pad = Math.max(1, Math.abs(min) * 0.05);
      min -= pad;
      max += pad;
    }
    const raw = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
    return { lo, hi, ticks };
  }

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent?.appendChild(e);
    return e;
  };

  // 三個小圖（日運量／車站數／路線數）共用時間軸，垂直排列；滑鼠或方向鍵移動十字線
  function drawChart(wrap, pts, key, onPick) {
    wrap.innerHTML = '';
    const rows = pts.map((p) => ({ p, x: p.by.get(key) || null }));
    if (rows.filter((r) => r.x).length < 2) {
      wrap.innerHTML = '<div class="muted">這份計劃的資料點不到兩個，還畫不出變化。</div>';
      return;
    }
    const W = Math.max(280, wrap.clientWidth);
    const L = 52;
    const R = 70;
    const PH = 64; // 每個小圖的繪圖高度
    const TH = 30; // 小圖標題列
    const GAP = 14;
    const XH = 22; // 底部時間軸
    const H = METRICS.length * (TH + PH + GAP) - GAP + XH;
    const t0 = rows[0].p.at;
    const t1 = rows[rows.length - 1].p.at;
    const span = Math.max(1, t1 - t0);
    const X = (t) => L + ((t - t0) / span) * (W - L - R);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'hc', tabindex: '0', role: 'img', 'aria-label': '日運量、車站數、路線數隨時間的變化，可用左右方向鍵查看每個版本' });

    const panels = METRICS.map((m, i) => {
      const top = i * (TH + PH + GAP) + TH;
      const vals = rows.filter((r) => r.x).map((r) => r.x[m.k]);
      const sc = niceScale(Math.min(...vals), Math.max(...vals));
      const Y = (v) => top + PH - ((v - sc.lo) / (sc.hi - sc.lo)) * PH;
      el('text', { x: 0, y: top - 14, class: 'hc-title' }, svg).textContent = m.name;
      for (const t of sc.ticks) {
        el('line', { x1: L, x2: W - R, y1: Y(t), y2: Y(t), class: 'hc-grid' }, svg);
        el('text', { x: L - 6, y: Y(t) + 4, class: 'hc-tick', 'text-anchor': 'end' }, svg).textContent = m.tick(t);
      }
      // 缺資料（那個版本沒有這份計劃）的地方斷開
      let d = '';
      let pen = false;
      for (const r of rows) {
        if (!r.x) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${X(r.p.at).toFixed(1)},${Y(r.x[m.k]).toFixed(1)}`;
        pen = true;
      }
      el('path', { d, class: 'hc-line' }, svg);
      // 資料點：點不多時全部標出；點多時只標前後都沒有資料、連不成線的孤立點
      rows.forEach((r, j) => {
        if (!r.x) return;
        const lone = !rows[j - 1]?.x && !rows[j + 1]?.x;
        if (lone || rows.length <= 40) el('circle', { cx: X(r.p.at), cy: Y(r.x[m.k]), r: lone ? 4 : 3, class: 'hc-dot' }, svg);
      });
      const last = [...rows].reverse().find((r) => r.x);
      el('circle', { cx: X(last.p.at), cy: Y(last.x[m.k]), r: 4, class: 'hc-dot' }, svg);
      el('text', { x: X(last.p.at) + 8, y: Y(last.x[m.k]) + 4, class: 'hc-end' }, svg).textContent = m.label(last.x[m.k]);
      const hover = el('circle', { r: 4, class: 'hc-dot hidden' }, svg);
      return { m, Y, hover };
    });

    // 時間軸：最多 4 個刻度，範圍不到兩天時顯示時間
    const withTime = span < 2 * 86400000;
    const n = Math.min(4, rows.length);
    for (let i = 0; i < n; i++) {
      const t = t0 + (span * i) / Math.max(1, n - 1);
      el('text', { x: X(t), y: H - 6, class: 'hc-tick', 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, svg).textContent = fmtShort(t, withTime);
    }

    const cross = el('line', { y1: TH - 4, y2: H - XH, class: 'hc-cross hidden' }, svg);
    const hit = el('rect', { x: L, y: 0, width: W - L - R + 8, height: H - XH, fill: 'transparent' }, svg);
    hit.style.cursor = 'pointer';
    wrap.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'hc-tip hidden';
    wrap.appendChild(tip);

    let cur = -1;
    const show = (i) => {
      cur = i;
      const r = rows[i];
      const x = X(r.p.at);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.classList.remove('hidden');
      for (const pn of panels) {
        pn.hover.classList.toggle('hidden', !r.x);
        if (r.x) {
          pn.hover.setAttribute('cx', x);
          pn.hover.setAttribute('cy', pn.Y(r.x[pn.m.k]));
        }
      }
      // 數值在前、名稱在後；名稱與裝置都是使用者資料，用 textContent
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'hc-tip-h';
      head.textContent = (r.p.current ? '目前・' : '') + fmtTime(r.p.at) + (r.p.device ? '・' + r.p.device : '');
      tip.appendChild(head);
      for (const m of METRICS) {
        const row = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = r.x ? fmtFull(r.x[m.k]) : '—';
        row.append(b, ' ' + m.name);
        tip.appendChild(row);
      }
      if (!r.x) tip.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: '這個版本沒有這份計劃' }));
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(0, x + 12 + tw > W ? x - tw - 12 : x + 12), W - tw) + 'px';
      tip.style.top = '6px';
    };
    const hide = () => {
      cross.classList.add('hidden');
      tip.classList.add('hidden');
      panels.forEach((pn) => pn.hover.classList.add('hidden'));
      cur = -1;
    };
    const nearest = (clientX) => {
      const px = clientX - svg.getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < rows.length; i++) if (Math.abs(X(rows[i].p.at) - px) < Math.abs(X(rows[best].p.at) - px)) best = i;
      return best;
    };
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    // 點一下：把這個版本設成比較的「舊版本」
    hit.addEventListener('click', (e) => onPick(rows[nearest(e.clientX)].p));
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        show(Math.min(rows.length - 1, Math.max(0, (cur < 0 ? rows.length : cur) + (e.key === 'ArrowLeft' ? -1 : 1))));
      } else if (e.key === 'Enter' && cur >= 0) onPick(rows[cur].p);
      else if (e.key === 'Escape') hide();
    });
    svg.addEventListener('blur', hide);
  }

  function tableHtml(pts, key) {
    const rows = [...pts].reverse().map((p) => {
      const x = p.by.get(key);
      return `<tr><td>${p.current ? '目前・' : ''}${esc(fmtTime(p.at))}</td><td>${esc(p.device || '')}</td>${METRICS.map((m) => `<td class="num">${x ? fmtFull(x[m.k]) : '—'}</td>`).join('')}</tr>`;
    });
    return `<div class="hc-table"><table><thead><tr><th>時間</th><th>裝置</th>${METRICS.map((m) => `<th class="num">${m.name}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  // ---------- 版本比較 ----------

  const deltaHtml = (a, b, f = fmtFull) => {
    if (a == null) return `<span class="d-add">新增</span> ${f(b)}`;
    if (b == null) return `${f(a)} <span class="d-del">已移除</span>`;
    const d = b - a;
    return `${f(a)} → <b>${f(b)}</b> <span class="${d > 0 ? 'd-up' : d < 0 ? 'd-down' : 'muted'}">${d > 0 ? '▲' : d < 0 ? '▼' : ''}${signed(d, f)}</span>`;
  };

  function summaryDiffHtml(A, B) {
    const keys = [...new Set([...B.slots, ...A.slots].map(slotKey))];
    if (!keys.length) return '<div class="muted">兩個版本都沒有計劃摘要。</div>';
    const rows = keys.map((k) => {
      const a = A.by.get(k);
      const b = B.by.get(k);
      const x = b || a;
      return `<tr><td>${esc(slotName(x))}</td>${METRICS.map((m) => `<td>${deltaHtml(a?.[m.k], b?.[m.k], m.k === 'r' ? fmtWan : fmtFull)}</td>`).join('')}</tr>`;
    });
    return `<div class="hc-table"><table><thead><tr><th>計劃</th>${METRICS.map((m) => `<th>${m.name}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  // psave 內容：「gz1:」開頭是 gzip＋base64，否則是 JSON
  async function readPlan(v) {
    if (typeof v !== 'string') return null;
    if (!v.startsWith('gz1:')) return JSON.parse(v);
    const bin = Uint8Array.from(atob(v.slice(4)), (c) => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  const list = (names, max = 30) => {
    const shown = names.slice(0, max).map(esc).join('、');
    return names.length > max ? `${shown} 等 ${names.length} 個` : shown;
  };

  // 比較同一份計劃的兩個內容，回傳變更項目的 HTML 陣列
  function diffPlan(a, b) {
    const out = [];
    const st = (p) => new Map((p?.stations || []).map((s) => [s.id, s.name || s.id]));
    const ln = (p) => new Map((p?.lines || []).map((l) => [l.id, l]));
    const sa = st(a);
    const sb = st(b);
    const la = ln(a);
    const lb = ln(b);
    const lname = (l) => l.name || l.id;
    const addL = [...lb.values()].filter((l) => !la.has(l.id)).map((l) => `${lname(l)}（${l.stops?.length || 0} 站）`);
    const delL = [...la.values()].filter((l) => !lb.has(l.id)).map((l) => `${lname(l)}（${l.stops?.length || 0} 站）`);
    const renL = [];
    const stopsL = [];
    const trainsL = [];
    for (const [id, l] of lb) {
      const o = la.get(id);
      if (!o) continue;
      if (lname(o) !== lname(l)) renL.push(`${lname(o)} → ${lname(l)}`);
      const n0 = o.stops?.length || 0;
      const n1 = l.stops?.length || 0;
      if (n0 !== n1) stopsL.push(`${lname(l)}：${n0} → ${n1} 站`);
      else if (JSON.stringify(o.stops) !== JSON.stringify(l.stops)) stopsL.push(`${lname(l)}：停靠站調整（仍是 ${n1} 站）`);
      if ((o.trains ?? null) !== (l.trains ?? null)) trainsL.push(`${lname(l)}：${o.trains ?? '?'} → ${l.trains ?? '?'} 列`);
    }
    const addS = [...sb].filter(([id]) => !sa.has(id)).map(([, n]) => n);
    const delS = [...sa].filter(([id]) => !sb.has(id)).map(([, n]) => n);
    const renS = [...sb].filter(([id, n]) => sa.has(id) && sa.get(id) !== n).map(([id, n]) => `${sa.get(id)} → ${n}`);
    const item = (cls, title, names) => names.length && out.push(`<li><span class="${cls}">${title}（${names.length}）</span>：${list(names)}</li>`);
    item('d-add', '新增路線', addL);
    item('d-del', '移除路線', delL);
    item('d-chg', '路線改名', renL);
    item('d-chg', '路線停靠站', stopsL);
    item('d-chg', '列車數', trainsL);
    item('d-add', '新增車站', addS);
    item('d-del', '移除車站', delS);
    item('d-chg', '車站改名', renS);
    return out;
  }

  async function detailDiffHtml(dataA, dataB) {
    const pa = new Map(C.listPlans(dataA).map((p) => [p.saveKey, p]));
    const pb = new Map(C.listPlans(dataB).map((p) => [p.saveKey, p]));
    const keys = [...new Set([...pb.keys(), ...pa.keys()])];
    const blocks = [];
    for (const k of keys) {
      const a = pa.get(k);
      const b = pb.get(k);
      const p = b || a;
      const title = `${esc(p.city)}・${esc(C.planLabel(p))}`;
      if (!a) {
        blocks.push(`<div class="cd"><b>${title}</b> <span class="d-add">新增的計劃</span>${b.summary ? `：${b.summary.st} 站 / ${b.summary.l} 線` : ''}</div>`);
        continue;
      }
      if (!b) {
        blocks.push(`<div class="cd"><b>${title}</b> <span class="d-del">這份計劃已移除</span></div>`);
        continue;
      }
      const va = dataA.keys[k];
      const vb = dataB.keys[k];
      if (va === vb) continue;
      let items;
      try {
        items = diffPlan(await readPlan(va), await readPlan(vb));
      } catch (e) {
        blocks.push(`<div class="cd"><b>${title}</b> <span class="muted">無法解析內容（${esc(e.message)}）</span></div>`);
        continue;
      }
      blocks.push(`<div class="cd"><b>${title}</b>${items.length ? `<ul>${items.join('')}</ul>` : ' <span class="muted">路線、車站沒有變化（營運數據或畫面設定有變）</span>'}</div>`);
    }
    return blocks.length ? blocks.join('') : '<div class="muted">兩個版本的計劃內容完全相同。</div>';
  }

  // ---------- 組裝 ----------

  // box：要放進去的容器；s：存檔 Meta；versions：歷史版本（由新到舊）；api：管理介面的 api()
  async function render(box, s, versions, api) {
    const pts = buildPoints(s, versions);
    const ptId = (p) => p.vid || 'current';

    const cache = new Map();
    const fetchData = (p) => {
      const id = ptId(p);
      if (!cache.has(id)) {
        const req = p.vid ? api(`/api/snapshots/${s.id}/versions/${p.vid}`) : api('/api/snapshots/' + s.id);
        cache.set(id, req.then((r) => r.data).catch((e) => (cache.delete(id), Promise.reject(e))));
      }
      return cache.get(id);
    };

    // 補上舊版本的計劃 id：先查快取，沒有才下載內容（同時最多 4 個）
    const todo = [];
    for (const p of pts) {
      if (!needsData(p)) continue;
      const ck = p.vid ? `${s.id}:${p.vid}` : null; // 目前的存檔內容會變，不快取
      const hit = ck && cacheGet(ck);
      if (hit) p.slots = hit;
      else todo.push({ p, ck });
    }
    if (todo.length) {
      let done = 0;
      const progress = () => (box.innerHTML = `<div class="muted">正在讀取 ${todo.length} 個較早版本的內容，辨識各計劃（${done}/${todo.length}）…</div>`);
      progress();
      const queue = [...todo];
      const failed = [];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let t; (t = queue.shift()); ) {
            try {
              t.p.slots = summarizeData(await fetchData(t.p));
              if (t.ck) cacheSet(t.ck, t.p.slots);
            } catch {
              failed.push(t.p);
            }
            done++;
            progress();
          }
        }),
      );
      // 讀不到的版本不畫（沒有 id 的資料無法正確對應計劃）
      for (const p of failed) p.slots = p.slots.filter((x) => slotKey(x));
    }
    index(pts);
    if (!box.isConnected) return;
    const plans = planOptions(pts);
    const now = pts[pts.length - 1].by;
    const ptLabel = (p) => (p.current ? '目前・' : '') + fmtTime(p.at) + (p.device ? '・' + p.device : '');
    const byId = new Map(pts.map((p) => [ptId(p), p]));
    const opts = [...pts].reverse().map((p) => `<option value="${esc(ptId(p))}">${esc(ptLabel(p))}</option>`).join('');
    box.innerHTML = `
      <div class="hist-h">成長圖表</div>
      ${plans.length
        ? `<div class="hist-bar"><select class="h-plan" aria-label="計劃">${plans.map((x) => `<option value="${esc(slotKey(x))}">${esc(slotName(x))}${now.has(slotKey(x)) ? '' : `（目前已不在，最後 ${x.st} 站）`}</option>`).join('')}</select>
           <span class="muted">滑過圖表看每個版本的數值，點一下設成比較的舊版本</span></div>
           <div class="hc-wrap"></div>
           <details class="hc-details"><summary>數值表</summary><div class="h-table"></div></details>`
        : '<div class="muted">這筆存檔和它的歷史版本都沒有計劃摘要。</div>'}
      <div class="hist-h">版本比較</div>
      <div class="hist-bar">
        <select class="h-a" aria-label="舊版本">${opts}</select><span>→</span>
        <select class="h-b" aria-label="新版本">${opts}</select>
        <button type="button" class="h-go">比較</button>
      </div>
      <div class="h-out"></div>`;
    const $ = (q) => box.querySelector(q);
    const selA = $('.h-a');
    const selB = $('.h-b');
    // 預設：最近一個歷史版本 → 目前
    selB.value = 'current';
    selA.value = versions[0]?.vid || 'current';

    if (plans.length) {
      const draw = () => {
        const key = $('.h-plan').value;
        drawChart($('.hc-wrap'), pts, key, (p) => {
          selA.value = ptId(p);
          $('.h-out').innerHTML = `<div class="muted">已選 ${esc(ptLabel(p))} 當舊版本，按「比較」開始。</div>`;
        });
        $('.h-table').innerHTML = tableHtml(pts, key);
      };
      $('.h-plan').addEventListener('change', draw);
      draw();
      // 寬度改變時重畫
      let w = box.clientWidth;
      const ro = new ResizeObserver(() => {
        if (!box.isConnected) return ro.disconnect();
        if (Math.abs(box.clientWidth - w) > 4 && box.offsetParent) (w = box.clientWidth), draw();
      });
      ro.observe(box);
    }

    $('.h-go').addEventListener('click', async (e) => {
      let A = byId.get(selA.value);
      let B = byId.get(selB.value);
      const out = $('.h-out');
      if (A === B) return (out.innerHTML = '<div class="muted">請選兩個不同的版本。</div>');
      if (A.at > B.at) [A, B] = [B, A]; // 一律由舊比到新
      out.innerHTML = `<div class="muted" style="margin-bottom:6px">${esc(ptLabel(A))} → ${esc(ptLabel(B))}</div>${summaryDiffHtml(A, B)}<div class="hist-h">路線與車站</div><div class="h-detail muted">下載兩個版本的內容中…</div>`;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const [da, db] = await Promise.all([fetchData(A), fetchData(B)]);
        const det = out.querySelector('.h-detail');
        det.classList.remove('muted');
        det.innerHTML = await detailDiffHtml(da, db);
      } catch (err) {
        out.querySelector('.h-detail').innerHTML = `<span class="err">${esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.MMSHistory = { render, niceScale, diffPlan, readPlan };
})();
