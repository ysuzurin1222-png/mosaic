/* ==========================================================================
   Latent — 習慣で写真を現像する
   目標は無制限。写真をタイルに分割し、達成した日ぶんだけタイルが外れる。
   ========================================================================== */
(() => {
'use strict';

/* ---------- 定数 ---------- */
const DB_NAME = 'mosaic-db';   // 旧名のまま。変えると既存の記録が読めなくなる
const DB_VER  = 2;
const STORE   = 'goals';
const PREFS   = 'prefs';
const DEFAULT_SPAN = 365;   // 期限なしのときのタイル数
const MAX_SPAN     = 3650;  // 上限（10年）
const MAX_EDGE     = 1400;  // 保存する写真の最大辺

/* ---------- 小道具 ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

const pad2 = n => String(n).padStart(2, '0');
const fmt  = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmt(d); };
const diffDays = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const today = () => fmt(new Date());
const pretty = s => s.replace(/-/g, '.');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

/* ==========================================================================
   保存（IndexedDB）
   ========================================================================== */
let dbp;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(PREFS)) d.createObjectStore(PREFS, { keyPath: 'key' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror  = () => rej(req.error);
  });
  return dbp;
}

async function tx(mode, fn, store = STORE) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror    = () => rej(t.error);
  });
}

const dbAll    = ()   => tx('readonly',  s => s.getAll());
const prefGet  = (k)  => tx('readonly',  s => s.get(k), PREFS);
const prefPut  = (o)  => tx('readwrite', s => s.put(o), PREFS);
const dbPut    = (g)  => tx('readwrite', s => s.put(g));
const dbDelete = (id) => tx('readwrite', s => s.delete(id));

/* ==========================================================================
   モデル
   ========================================================================== */
const state = {
  goals: [],       // メモリ上のキャッシュ
  urls: new Map(), // id -> objectURL
  current: null,   // 表示中の目標
  layout: null,    // 表示中のタイル配置
  editingId: null,
  pendingPhoto: null,
  pendingUrl: null,   // プレビュー用
  cropUrl: null,      // 切り抜き前の元写真
};

function spanOf(g) {
  if (!g.end) return DEFAULT_SPAN;
  return clamp(diffDays(g.start, g.end) + 1, 1, MAX_SPAN);
}
function lastDateOf(g) {
  return g.end ? g.end : addDays(g.start, DEFAULT_SPAN - 1);
}
function doneSet(g) {
  return new Set(g.done || []);
}
function openCount(g) {
  const total = spanOf(g), set = doneSet(g);
  let n = 0;
  for (const d of set) {
    const i = diffDays(g.start, d);
    if (i >= 0 && i < total) n++;
  }
  return n;
}
function elapsedOf(g) {
  return clamp(diffDays(g.start, today()) + 1, 0, spanOf(g));
}
function streakOf(g) {
  const set = doneSet(g);
  const last = lastDateOf(g);
  let cursor = today() > last ? last : today();
  if (!set.has(cursor)) cursor = addDays(cursor, -1); // 今日はまだ未記録でも継続扱い
  let n = 0;
  while (set.has(cursor) && cursor >= g.start) { n++; cursor = addDays(cursor, -1); }
  return n;
}
function urlFor(g) {
  if (!state.urls.has(g.id)) state.urls.set(g.id, URL.createObjectURL(g.photo));
  return state.urls.get(g.id);
}
function dropUrl(id) {
  if (state.urls.has(id)) { URL.revokeObjectURL(state.urls.get(id)); state.urls.delete(id); }
}

/* ==========================================================================
   タイル配置
   n 個のタイルで写真をきっちり覆う。タイルはできるだけ正方形に近づける。
   端数は「1枚少ない行」を全体に散らして吸収する（最終行だけ間延びさせない）。
   ========================================================================== */
function computeLayout(n, aspect) {
  n = Math.max(1, Math.round(n));
  aspect = clamp(aspect || 1, 0.2, 5);

  let cols = clamp(Math.round(Math.sqrt(n * aspect)), 1, n);
  let rows, d, guard = 0;
  while (guard++ < 200) {
    rows = Math.ceil(n / cols);
    d = rows * cols - n;
    if (d < rows || cols <= 1) break;
    cols--;
  }
  rows = Math.ceil(n / cols);
  d = rows * cols - n;

  const counts = [];
  for (let r = 0; r < rows; r++) {
    const short = Math.floor((r + 1) * d / rows) > Math.floor(r * d / rows);
    counts.push(Math.max(1, cols - (short ? 1 : 0)));
  }
  // 端数の微調整
  let sum = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; sum > n && i < counts.length * 3; i++) {
    const k = i % counts.length;
    if (counts[k] > 1) { counts[k]--; sum--; }
  }
  while (sum < n) { counts[counts.length - 1]++; sum++; }

  const rects = [];
  const h = 1 / rows;
  counts.forEach((c, r) => {
    const w = 1 / c;
    for (let k = 0; k < c; k++) rects.push({ x: k * w, y: r * h, w, h });
  });
  return { rects: rects.slice(0, n), counts, cols, rows };
}

/* ==========================================================================
   写真の取り込み（縮小して JPEG 化）
   ========================================================================== */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image'));
    img.src = src;
  });
}

async function processPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.min(1, MAX_EDGE / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    return { blob, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ==========================================================================
   一覧画面
   ========================================================================== */
const listEl  = $('#goal-list');
const emptyEl = $('#list-empty');

function renderList() {
  const goals = state.goals;
  emptyEl.hidden = goals.length > 0;
  listEl.hidden  = goals.length === 0;
  listEl.innerHTML = '';

  const mode = state.prefs.view === 'name' ? 'name' : 'photo';
  listEl.className = 'sheet sheet--' + mode;
  paintViewToggle();

  goals.forEach(g => {
    const total = spanOf(g);
    const open  = openCount(g);
    const pct   = Math.round(open / total * 100);
    const done  = today() > lastDateOf(g);
    const sub   = done ? `終了 ・ ${open} / ${total}`
                       : `のこり ${total - elapsedOf(g)}日 ・ ${open} / ${total}`;

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';

    if (mode === 'photo') {
      btn.className = 'shot' + (pct === 100 ? ' is-done' : '');
      btn.innerHTML = `
        <span class="shot__frame"><canvas class="shot__img"></canvas></span>
        <span class="shot__foot">
          <span class="shot__text">
            <span class="shot__title"></span>
            <span class="shot__sub mono"></span>
          </span>
          <span class="shot__pct mono">${pct}<i>%</i></span>
        </span>`;
      btn.querySelector('.shot__title').textContent = g.title;
      btn.querySelector('.shot__sub').textContent = sub;
    } else {
      btn.className = 'row' + (pct === 100 ? ' is-done' : '');
      btn.innerHTML = `
        <span class="row__text">
          <span class="row__title"></span>
          <span class="row__meter"><i style="width:${pct}%"></i></span>
        </span>
        <span class="row__pct mono">${pct}<i>%</i></span>`;
      btn.querySelector('.row__title').textContent = g.title;
      btn.title = sub;
    }

    btn.addEventListener('click', () => openDetail(g.id));
    li.appendChild(btn);
    listEl.appendChild(li);

    if (mode === 'photo') {
      const cv = btn.querySelector('canvas');
      if (g.pw && g.ph) {          // 高さを先に決めておくと、読み込み時に跳ねない
        cv.width = 560;
        cv.height = Math.max(1, Math.round(560 * g.ph / g.pw));
      }
      drawThumb(cv, g, true);
    }
  });
}

/* 表示モードの切り替え */
function paintViewToggle() {
  const b = $('#btn-view');
  if (!b) return;
  const photo = state.prefs.view !== 'name';
  b.setAttribute('aria-label', photo ? '名前だけの表示に切り替え' : '写真の表示に切り替え');
  b.innerHTML = photo
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';
}

async function drawThumb(cv, g, fit) {
  let img;
  try { img = await loadImage(urlFor(g)); } catch { return; }

  if (fit) {
    // 切り抜いた写真をそのまま、余白なしで
    const w = 560;
    cv.width  = w;
    cv.height = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
  } else if (!cv.width) {
    cv.width = cv.height = 152;
  }

  const ctx = cv.getContext('2d');
  const cw = cv.width, ch = cv.height;
  ctx.fillStyle = '#161C1F';
  ctx.fillRect(0, 0, cw, ch);

  const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);

  const total = spanOf(g);
  const { counts } = computeLayout(total, img.naturalWidth / img.naturalHeight);
  const set = doneSet(g);
  const t = today();
  const rows = counts.length;

  let i = 0;
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round(r * ch / rows);
    const y1 = Math.round((r + 1) * ch / rows);
    const c = counts[r];
    for (let k = 0; k < c; k++, i++) {
      const date = addDays(g.start, i);
      if (set.has(date)) continue;
      const x0 = Math.round(k * cw / c);
      const x1 = Math.round((k + 1) * cw / c);
      ctx.fillStyle = date < t ? '#7C8488' : '#4E5659';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/* ==========================================================================
   詳細画面
   ========================================================================== */
const tilesEl = $('#mosaic-tiles');
const imgEl   = $('#mosaic-img');

async function openDetail(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  state.current = g;

  $('#detail-title').textContent = g.title;
  imgEl.src = urlFor(g);
  imgEl.alt = `${g.title} の写真`;

  showView('detail');
  try {
    const img = await loadImage(imgEl.src);
    state.layout = computeLayout(spanOf(g), img.naturalWidth / img.naturalHeight);
  } catch {
    state.layout = computeLayout(spanOf(g), 1);
  }
  buildTiles();
  refreshDetail();
  $('.detail__scroll').scrollTop = 0;
}

/* タイルの境界は必ず整数ピクセルに丸める。
   隣り合うタイルが「同じ丸めた座標」を共有するので、隙間も重なりも出ない。 */
function buildTiles() {
  const g = state.current;
  if (!g || !state.layout) return;
  const box = tilesEl.getBoundingClientRect();
  const W = Math.ceil(box.width);
  const H = Math.ceil(box.height);
  if (W < 2 || H < 2) return;   // まだ描画されていない

  const counts = state.layout.counts;
  const rows = counts.length;
  const parts = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round(r * H / rows);
    const y1 = Math.round((r + 1) * H / rows);
    const c = counts[r];
    for (let k = 0; k < c; k++) {
      const x0 = Math.round(k * W / c);
      const x1 = Math.round((k + 1) * W / c);
      parts.push(`<div class="tile" data-i="${i}" style="left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"></div>`);
      i++;
    }
  }
  tilesEl.innerHTML = parts.join('');
  state.builtW = W;
  state.builtH = H;
  paintTiles(g);
}

/* 画面の回転や幅の変化でタイルを組み直す */
let resizeRaf = 0;
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (!state.current) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      const box = tilesEl.getBoundingClientRect();
      if (Math.ceil(box.width) === state.builtW && Math.ceil(box.height) === state.builtH) return;
      buildTiles();
    });
  }).observe(tilesEl);
}

function paintTiles(g) {
  const set = doneSet(g);
  const t = today();
  const kids = tilesEl.children;
  for (let i = 0; i < kids.length; i++) {
    const date = addDays(g.start, i);
    const el = kids[i];
    el.className = 'tile'
      + (set.has(date) ? ' is-open' : '')
      + (!set.has(date) && date < t ? ' is-miss' : '')
      + (date === t ? ' is-today' : '');
  }
}

function refreshDetail() {
  const g = state.current;
  const total = spanOf(g);
  const open = openCount(g);
  const pct = Math.round(open / total * 100);
  const elapsed = elapsedOf(g);
  const last = lastDateOf(g);
  const finished = today() > last;

  $('#stat-pct').innerHTML = `${pct}<i>%</i>`;
  $('#stat-bar').style.width = pct + '%';
  $('#stat-elapsed').style.left = (elapsed / total * 100) + '%';
  $('#stat-elapsed').style.display = finished ? 'none' : '';
  $('#stat-open').textContent  = `${open} / ${total}`;
  $('#stat-rate').textContent  = elapsed ? Math.round(open / elapsed * 100) + '%' : '—';
  $('#stat-streak').textContent = streakOf(g) + '日';
  $('#stat-left').textContent  = finished ? '終了' : (total - elapsed) + '日';
  $('#frame-range').textContent = `${pretty(g.start)} — ${pretty(last)}`;
  $('#frame-count').textContent = `${open} / ${total}`;

  const btn = $('#btn-today');
  const t = today();
  const has = doneSet(g).has(t);
  btn.classList.toggle('is-undo', has);
  if (t < g.start)      { btn.disabled = true;  btn.textContent = `${pretty(g.start)} から始まります`; }
  else if (finished)    { btn.disabled = true;  btn.textContent = '期間は終了しました'; }
  else if (has)         { btn.disabled = false; btn.textContent = '今日は達成ずみ ・ 取り消す'; }
  else                  { btn.disabled = false; btn.textContent = '今日を達成にする'; }
}

async function setDay(g, date, want) {
  const set = doneSet(g);
  if (want) set.add(date); else set.delete(date);
  g.done = Array.from(set).sort();
  await dbPut(g);
  paintTiles(g);
  refreshDetail();
}

/* タイルをタップ → その日の記録シートを開く */
tilesEl.addEventListener('click', e => {
  const el = e.target.closest('.tile');
  if (!el || !state.current) return;
  openDaySheet(addDays(state.current.start, Number(el.dataset.i)));
});

$('#btn-today').addEventListener('click', async () => {
  const g = state.current;
  const t = today();
  const has = doneSet(g).has(t);
  await setDay(g, t, !has);
  toast(has ? '今日の記録を取り消しました' : 'タイルが1枚外れました');
});

$('#btn-back').addEventListener('click', () => { renderList(); showView('list'); });

/* ==========================================================================
   1日の記録シート
   ========================================================================== */
function openDaySheet(date) {
  const g = state.current;
  const input = $('#d-date');
  input.min = g.start;
  input.max = lastDateOf(g);
  input.value = date || today();
  $('#d-error').hidden = true;
  updateDayMeta();
  openScrim('daysheet');
}

function updateDayMeta() {
  const g = state.current;
  const date = $('#d-date').value;
  const meta = $('#d-meta');
  if (!date) { meta.textContent = ''; return; }
  const i = diffDays(g.start, date);
  const total = spanOf(g);
  const has = doneSet(g).has(date);
  const future = date > today();
  const parts = [`${i + 1} / ${total} 枚目のタイル`];
  parts.push(has ? '達成ずみ' : (future ? 'これから来る日' : 'まだ未記録'));
  meta.textContent = parts.join(' ・ ');
  $('#btn-day-set').disabled = has || future || i < 0 || i >= total;
  $('#btn-day-clear').disabled = !has;
}

$('#d-date').addEventListener('input', updateDayMeta);

$('#btn-day-set').addEventListener('click', async () => {
  const g = state.current, date = $('#d-date').value;
  const err = $('#d-error');
  const i = diffDays(g.start, date);
  if (!date || i < 0 || i >= spanOf(g)) { err.textContent = '期間の外の日付です。'; err.hidden = false; return; }
  if (date > today()) { err.textContent = '未来の日付は達成にできません。'; err.hidden = false; return; }
  await setDay(g, date, true);
  closeScrim('daysheet');
  toast(`${pretty(date)} を達成にしました`);
});

$('#btn-day-clear').addEventListener('click', async () => {
  const g = state.current, date = $('#d-date').value;
  await setDay(g, date, false);
  closeScrim('daysheet');
  toast(`${pretty(date)} の記録を取り消しました`);
});

$('#btn-fix').addEventListener('click', () => openDaySheet(today()));

/* ==========================================================================
   目標の作成 / 編集
   ========================================================================== */
function openEditor(goal) {
  state.editingId = goal ? goal.id : null;
  state.pendingPhoto = null;
  if (state.pendingUrl) { URL.revokeObjectURL(state.pendingUrl); state.pendingUrl = null; }
  if (state.cropUrl)    { URL.revokeObjectURL(state.cropUrl);    state.cropUrl = null; }
  $('#btn-recrop').hidden = true;

  $('#editor-title').textContent = goal ? '目標を編集' : '目標を追加';
  $('#f-title').value = goal ? goal.title : '';
  $('#f-start').value = goal ? goal.start : today();
  $('#f-noend').checked = goal ? !goal.end : false;
  $('#f-end').value = goal && goal.end ? goal.end : addDays(today(), 29);
  $('#editor-error').hidden = true;

  const prev = $('#photo-preview');
  if (goal) { prev.src = urlFor(goal); prev.hidden = false; $('#photo-hint').hidden = true; }
  else      { prev.removeAttribute('src'); prev.hidden = true; $('#photo-hint').hidden = false; }

  syncEndState();
  updateCalc();
  openScrim('editor');
}

function syncEndState() {
  const off = $('#f-noend').checked;
  $('#f-end').disabled = off;
  $('#f-end').closest('.field').style.opacity = off ? .4 : 1;
}

function editorSpan() {
  const start = $('#f-start').value;
  if (!start) return null;
  if ($('#f-noend').checked) return DEFAULT_SPAN;
  const end = $('#f-end').value;
  if (!end) return null;
  const n = diffDays(start, end) + 1;
  return n;
}

function editorAspect() {
  if (state.pendingPhoto) return state.pendingPhoto.w / state.pendingPhoto.h;
  const g = state.editingId ? state.goals.find(x => x.id === state.editingId) : null;
  if (g && g.pw && g.ph) return g.pw / g.ph;
  return 1.4;
}

function updateCalc() {
  const n = editorSpan();
  const el = $('#editor-calc');
  if (!n || n < 1) { el.textContent = '開始日と期限を入れると、タイルの枚数が決まります。'; return; }
  const capped = Math.min(n, MAX_SPAN);
  const { cols, rows } = computeLayout(capped, editorAspect());
  el.textContent = `${capped} 日間 → タイル ${capped} 枚（およそ ${cols} × ${rows}）`;
}

['#f-start', '#f-end'].forEach(s => $(s).addEventListener('input', updateCalc));
$('#f-noend').addEventListener('change', () => { syncEndState(); updateCalc(); });

const photoDrop = $('#photo-drop');
photoDrop.addEventListener('click', () => $('#photo-input').click());
photoDrop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#photo-input').click(); }
});
$('#photo-input').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await openCropper(file);
  } catch {
    // 切り抜き画面が開けなかったときは、写真をそのまま使う
    try {
      applyPending(await processPhoto(file));
      toast('切り抜きは使えないので、写真全体を使います');
    } catch {
      toast('この写真は読み込めませんでした');
    }
  }
});

/* 切り抜き結果を編集画面に反映する */
function applyPending(p) {
  if (state.pendingUrl) URL.revokeObjectURL(state.pendingUrl);
  state.pendingPhoto = p;
  state.pendingUrl = URL.createObjectURL(p.blob);
  const prev = $('#photo-preview');
  prev.src = state.pendingUrl;
  prev.hidden = false;
  $('#photo-hint').hidden = true;
  $('#btn-recrop').hidden = !state.cropUrl;
  updateCalc();
}

/* ==========================================================================
   切り抜き
   枠は動かさず、中の写真を動かす方式。枠は必ず写真で埋まる。
   ========================================================================== */
const AR_LIST = [1.33333, 1, 0.75, 1.77778];
const stageEl = $('#crop-stage');
const cropImg = $('#crop-img');
const zoomEl  = $('#crop-zoom');

const crop = { ar: 4 / 3, zoom: 1, tx: 0, ty: 0, Fw: 0, Fh: 0 };

const cropNat = () => ({ w: cropImg.naturalWidth || 1, h: cropImg.naturalHeight || 1 });
function cropScale() {
  const n = cropNat();
  return Math.max(crop.Fw / n.w, crop.Fh / n.h) * crop.zoom;
}
function cropRender() {
  const n = cropNat();
  const s = cropScale();
  const Dw = n.w * s, Dh = n.h * s;
  crop.tx = Math.min(0, Math.max(crop.Fw - Dw, crop.tx));
  crop.ty = Math.min(0, Math.max(crop.Fh - Dh, crop.ty));
  cropImg.style.width  = Dw + 'px';
  cropImg.style.height = Dh + 'px';
  cropImg.style.transform = `translate(${crop.tx}px, ${crop.ty}px)`;
}
function cropCenter() {
  const n = cropNat(), s = cropScale();
  crop.tx = (crop.Fw - n.w * s) / 2;
  crop.ty = (crop.Fh - n.h * s) / 2;
}
function cropMeasure() {
  const r = stageEl.getBoundingClientRect();
  crop.Fw = r.width;
  crop.Fh = r.height;
}
function cropSetAspect(ar, keep) {
  crop.ar = ar;
  stageEl.style.aspectRatio = String(ar);
  $$('#crop-ratios .chip').forEach(c => c.classList.toggle('is-on', Math.abs(Number(c.dataset.ar) - ar) < 0.01));
  requestAnimationFrame(() => {
    cropMeasure();
    if (!keep) { crop.zoom = 1; zoomEl.value = '1'; }
    cropCenter();
    cropRender();
  });
}

async function openCropper(file) {
  if (state.cropUrl) URL.revokeObjectURL(state.cropUrl);
  state.cropUrl = URL.createObjectURL(file);
  cropImg.src = state.cropUrl;
  await new Promise((res, rej) => {
    if (cropImg.complete && cropImg.naturalWidth) return res();
    cropImg.onload = res;
    cropImg.onerror = () => rej(new Error('image'));
  });
  const n = cropNat();
  const own = n.w / n.h;
  const near = AR_LIST.reduce((a, b) => Math.abs(b - own) < Math.abs(a - own) ? b : a, AR_LIST[0]);
  openScrim('cropper');
  cropSetAspect(near, false);
}

function reopenCropper() {
  if (!state.cropUrl) return;
  openScrim('cropper');
  requestAnimationFrame(() => { cropMeasure(); cropRender(); });
}

$('#btn-recrop').addEventListener('click', reopenCropper);

$('#crop-ratios').addEventListener('click', e => {
  const c = e.target.closest('.chip');
  if (c) cropSetAspect(Number(c.dataset.ar), false);
});

zoomEl.addEventListener('input', () => {
  const cx = crop.Fw / 2, cy = crop.Fh / 2;
  const s0 = cropScale();
  const ix = (cx - crop.tx) / s0, iy = (cy - crop.ty) / s0;
  crop.zoom = Number(zoomEl.value);
  const s1 = cropScale();
  crop.tx = cx - ix * s1;
  crop.ty = cy - iy * s1;
  cropRender();
});

/* ドラッグと、指2本での拡大縮小 */
const pts = new Map();
let pinch = null;

stageEl.addEventListener('pointerdown', e => {
  stageEl.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) {
    const [a, b] = Array.from(pts.values());
    const r = stageEl.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const s = cropScale();
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: crop.zoom,
      ix: (mx - crop.tx) / s,
      iy: (my - crop.ty) / s,
    };
  }
});

stageEl.addEventListener('pointermove', e => {
  const prev = pts.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };

  if (pts.size === 1) {
    crop.tx += cur.x - prev.x;
    crop.ty += cur.y - prev.y;
    pts.set(e.pointerId, cur);
    cropRender();
    return;
  }

  pts.set(e.pointerId, cur);
  if (pts.size === 2 && pinch) {
    const [a, b] = Array.from(pts.values());
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pinch.dist) return;
    crop.zoom = clamp(pinch.zoom * (dist / pinch.dist), 1, 5);
    zoomEl.value = String(crop.zoom);
    const r = stageEl.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const s = cropScale();
    crop.tx = mx - pinch.ix * s;
    crop.ty = my - pinch.iy * s;
    cropRender();
  }
});

function pointerEnd(e) {
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
}
stageEl.addEventListener('pointerup', pointerEnd);
stageEl.addEventListener('pointercancel', pointerEnd);

stageEl.addEventListener('wheel', e => {
  e.preventDefault();
  const r = stageEl.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const s0 = cropScale();
  const ix = (mx - crop.tx) / s0, iy = (my - crop.ty) / s0;
  crop.zoom = clamp(crop.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 1, 5);
  zoomEl.value = String(crop.zoom);
  const s1 = cropScale();
  crop.tx = mx - ix * s1;
  crop.ty = my - iy * s1;
  cropRender();
}, { passive: false });

$('#btn-crop-ok').addEventListener('click', async () => {
  const n = cropNat();
  const s = cropScale();
  const sx = clamp(-crop.tx / s, 0, n.w);
  const sy = clamp(-crop.ty / s, 0, n.h);
  const sw = clamp(crop.Fw / s, 1, n.w - sx);
  const sh = clamp(crop.Fh / s, 1, n.h - sy);

  let outW, outH;
  if (crop.Fw >= crop.Fh) {
    outW = Math.max(1, Math.round(Math.min(sw, MAX_EDGE)));
    outH = Math.max(1, Math.round(outW * crop.Fh / crop.Fw));
  } else {
    outH = Math.max(1, Math.round(Math.min(sh, MAX_EDGE)));
    outW = Math.max(1, Math.round(outH * crop.Fw / crop.Fh));
  }

  const cv = document.createElement('canvas');
  cv.width = outW; cv.height = outH;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(cropImg, sx, sy, sw, sh, 0, 0, outW, outH);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));

  applyPending({ blob, w: outW, h: outH });
  closeScrim('cropper');
});

$('#btn-save').addEventListener('click', async () => {
  const err = $('#editor-error');
  const title = $('#f-title').value.trim();
  const start = $('#f-start').value;
  const noend = $('#f-noend').checked;
  const end = noend ? null : $('#f-end').value;
  const existing = state.editingId ? state.goals.find(g => g.id === state.editingId) : null;

  const fail = m => { err.textContent = m; err.hidden = false; };
  if (!state.pendingPhoto && !existing) return fail('写真を選んでください。');
  if (!title) return fail('目標の名前を入れてください。');
  if (!start) return fail('開始日を入れてください。');
  if (!noend && !end) return fail('期限を入れるか、期限を決めないを選んでください。');
  if (end && diffDays(start, end) < 0) return fail('期限は開始日より後にしてください。');
  if (end && diffDays(start, end) + 1 > MAX_SPAN) return fail(`期間は最長 ${MAX_SPAN} 日までです。`);

  const goal = existing || { id: uid(), done: [], createdAt: Date.now() };
  goal.title = title;
  goal.start = start;
  goal.end   = end;
  if (state.pendingPhoto) {
    goal.photo = state.pendingPhoto.blob;
    goal.pw = state.pendingPhoto.w;
    goal.ph = state.pendingPhoto.h;
    dropUrl(goal.id);
  }
  // 期間の外に出た記録は捨てる
  const span = spanOf(goal);
  goal.done = (goal.done || []).filter(d => {
    const i = diffDays(goal.start, d);
    return i >= 0 && i < span;
  }).sort();

  await dbPut(goal);
  if (!existing) state.goals.push(goal);
  sortGoals();
  closeScrim('editor');

  if (state.current && state.current.id === goal.id) await openDetail(goal.id);
  else { renderList(); showView('list'); }
  toast(existing ? '目標を更新しました' : '目標を追加しました');
});

/* ==========================================================================
   目標メニュー
   ========================================================================== */
$('#btn-goal-menu').addEventListener('click', () => openScrim('goalmenu'));

$('#btn-edit').addEventListener('click', () => {
  closeScrim('goalmenu');
  openEditor(state.current);
});

$('#btn-delete').addEventListener('click', async () => {
  const g = state.current;
  if (!confirm(`「${g.title}」を削除します。写真と記録も一緒に消えます。`)) return;
  await dbDelete(g.id);
  dropUrl(g.id);
  state.goals = state.goals.filter(x => x.id !== g.id);
  state.current = null;
  closeScrim('goalmenu');
  renderList();
  showView('list');
  toast('目標を削除しました');
});

/* ==========================================================================
   設定 / 書き出し・読み込み
   ========================================================================== */
$('#btn-menu').addEventListener('click', () => {
  const n = state.goals.length;
  const tiles = state.goals.reduce((a, g) => a + openCount(g), 0);
  $('#menu-stat').textContent = `目標 ${n} 件 ・ 外したタイル ${tiles} 枚`;
  paintPrefs();
  openScrim('menu');
});

const blobToDataURL = b => new Promise(res => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.readAsDataURL(b);
});

async function dataURLToBlob(u) {
  const [head, b64] = u.split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

$('#btn-export').addEventListener('click', async () => {
  if (!state.goals.length) { toast('書き出せる目標がありません'); return; }
  toast('書き出しています…');
  const goals = [];
  for (const g of state.goals) {
    goals.push({
      id: g.id, title: g.title, start: g.start, end: g.end,
      done: g.done || [], createdAt: g.createdAt, pw: g.pw, ph: g.ph,
      photo: await blobToDataURL(g.photo),
    });
  }
  const payload = { app: 'latent', version: 1, exportedAt: new Date().toISOString(), goals };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `latent-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$('#btn-import').addEventListener('click', () => $('#import-input').click());

$('#import-input').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || (data.app !== 'latent' && data.app !== 'mosaic') || !Array.isArray(data.goals)) throw new Error('format');
    for (const raw of data.goals) {
      const goal = {
        id: raw.id || uid(),
        title: raw.title || '無題',
        start: raw.start, end: raw.end || null,
        done: Array.isArray(raw.done) ? raw.done : [],
        createdAt: raw.createdAt || Date.now(),
        pw: raw.pw, ph: raw.ph,
        photo: await dataURLToBlob(raw.photo),
      };
      await dbPut(goal);
      dropUrl(goal.id);
    }
    await load();
    closeScrim('menu');
    renderList();
    toast(`${data.goals.length} 件を読み込みました`);
  } catch {
    toast('このファイルは読み込めませんでした');
  }
});

/* ==========================================================================
   画面・モーダルの制御
   ========================================================================== */
function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + name));
  window.scrollTo(0, 0);
}

function openScrim(id)  { $('#' + id).hidden = false; }
function closeScrim(id) { $('#' + id).hidden = true; }

$$('[data-close]').forEach(b => b.addEventListener('click', () => closeScrim(b.dataset.close)));
$$('.scrim').forEach(s => s.addEventListener('click', e => {
  if (s.id === 'cropper') return;   // ドラッグの終わりで閉じてしまうのを防ぐ
  if (e.target === s) s.hidden = true;
}));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = $$('.scrim').find(s => !s.hidden);
  if (open) open.hidden = true;
});

$('#btn-view').addEventListener('click', () => {
  state.prefs.view = state.prefs.view === 'name' ? 'photo' : 'name';
  savePrefs();
  renderList();
});

$('#fab').addEventListener('click', () => openEditor(null));
$$('[data-action="new"]').forEach(b => b.addEventListener('click', () => openEditor(null)));

/* ==========================================================================
   通知
   文面は messages.js（データ）、ここは「いつ・どれを出すか」だけを決める。
   実際に予約する部分は notifier に閉じてあるので、アプリ版に移すときは
   notifier.schedule の中身を差し替えるだけで済む。
   ========================================================================== */
const SLOT_ORDER = ['morning', 'evening', 'night'];

const DEFAULT_PREFS = {
  key: 'notify',
  tone: 'plain',
  view: 'photo',   // 'photo'（写真）か 'name'（名前だけ）
  slots: {
    morning: { on: true,  at: '08:00' },
    evening: { on: false, at: '18:00' },
    night:   { on: true,  at: '21:00' },
  },
};

state.prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));

async function loadPrefs() {
  try {
    const got = await prefGet('notify');
    if (got && got.key === 'notify') {
      state.prefs.tone = got.tone || DEFAULT_PREFS.tone;
      state.prefs.view = got.view || DEFAULT_PREFS.view;
      SLOT_ORDER.forEach(k => {
        if (got.slots && got.slots[k]) state.prefs.slots[k] = got.slots[k];
      });
    }
  } catch { /* 既定値のまま */ }
}
const savePrefs = () => prefPut(state.prefs).catch(() => {});

/* いま通知を出すとしたら、何を伝えるか */
function notifyContext() {
  const t = today();
  const active = state.goals.filter(g => t >= g.start && t <= lastDateOf(g));
  const pending = active.filter(g => !doneSet(g).has(t));
  if (!pending.length) return null;              // 全部記録ずみ → 送らない

  const one = pending.length === 1;
  const g = pending[0];
  const total = spanOf(g);
  const open = openCount(g);
  const left = total - open;
  const streak = streakOf(g);
  const yday = addDays(t, -1);
  const broke = yday >= g.start && !doneSet(g).has(yday);

  let situation = 'normal';
  if (one) {
    if (left <= 5) situation = 'near';
    else if (broke) situation = 'broke';
    else if (streak >= 3) situation = 'streak';
  }

  return {
    one, situation,
    count: pending.length,
    vars: {
      target: one ? g.title : `未記録の目標が${pending.length}つ`,
      tile:   one ? String(diffDays(g.start, t) + 1) : '',
      total:  one ? String(total) : '',
      left:   one ? String(left) : '',
      streak: one ? String(streak) : '',
      pct:    one ? String(Math.round(open / total * 100)) : '',
    },
  };
}

function pickLine(tone, slot, ctx, nth) {
  const M = window.LATENT_MESSAGES;
  if (!M) return null;
  const group = M.lines[tone] && M.lines[tone][slot];
  if (!group) return null;
  const bucket = ctx.one ? group.one : group.many;
  const pool = (bucket && (bucket[ctx.situation] || bucket.normal)) || group.one.normal;
  if (!pool || !pool.length) return null;
  const tpl = pool[((nth % pool.length) + pool.length) % pool.length];
  const fill = str => str.replace(/\{(\w+)\}/g, (m, k) => (ctx.vars[k] !== undefined ? ctx.vars[k] : m));
  return { title: fill(tpl.title), body: fill(tpl.body) };
}

/* 通知の出し口。いまは端末に予約する手段がないので、確認だけできる状態。 */
const notifier = {
  kind: (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
        ? 'native' : 'web',
  supported() { return this.kind === 'native'; },
  async schedule() {
    // アプリ版ではここで端末に予約する。
    // 例）LocalNotifications.schedule({ notifications: buildPlan() })
    return false;
  },
};

/* 予約したい内容の一覧。アプリ版に渡すのはこの形。 */
function buildPlan() {
  const ctx = notifyContext();
  if (!ctx) return [];
  return SLOT_ORDER
    .filter(k => state.prefs.slots[k].on)
    .map((k, i) => {
      const line = pickLine(state.prefs.tone, k, ctx, previewSeed + i);
      return line ? { slot: k, at: state.prefs.slots[k].at, ...line } : null;
    })
    .filter(Boolean);
}

/* ---------- 設定画面 ---------- */
function paintPrefs() {
  $$('#tone-pick .chip').forEach(c => c.classList.toggle('is-on', c.dataset.tone === state.prefs.tone));
  SLOT_ORDER.forEach(k => {
    const on = state.prefs.slots[k].on;
    $(`[data-slot="${k}"]`).checked = on;
    const at = $(`[data-slot-at="${k}"]`);
    at.value = state.prefs.slots[k].at;
    at.disabled = !on;
  });
  const n = SLOT_ORDER.filter(k => state.prefs.slots[k].on).length;
  $('#notify-state').textContent = notifier.supported()
    ? `1日 最大${n}回まで送られます。`
    : `1日 最大${n}回の設定です。実際の送信はアプリ版で有効になります（いまは文面の確認だけできます）。`;
}

$('#tone-pick').addEventListener('click', e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  state.prefs.tone = c.dataset.tone;
  savePrefs();
  paintPrefs();
});

SLOT_ORDER.forEach(k => {
  $(`[data-slot="${k}"]`).addEventListener('change', e => {
    state.prefs.slots[k].on = e.target.checked;
    savePrefs();
    paintPrefs();
  });
  $(`[data-slot-at="${k}"]`).addEventListener('input', e => {
    if (!e.target.value) return;
    state.prefs.slots[k].at = e.target.value;
    savePrefs();
  });
  // 時刻欄をさわってもチェックが切り替わらないように
  $(`[data-slot-at="${k}"]`).addEventListener('click', e => e.preventDefault());
});

/* ---------- 文面の確認 ---------- */
let previewSeed = 0;
let previewTone = null;

function renderPreview() {
  const tone = previewTone || state.prefs.tone;
  $$('#preview-tone .chip').forEach(c => c.classList.toggle('is-on', c.dataset.tone === tone));

  const list = $('#preview-list');
  const note = $('#preview-note');
  const ctx = notifyContext();

  if (!ctx) {
    note.textContent = '今日は未記録の目標がないので、通知は送られません。';
    list.innerHTML = '';
    return;
  }

  const label = { normal: 'ふつうの未記録', streak: '連続している', broke: '昨日を落とした', near: '完成まであと少し' };
  note.textContent = `いまの状況：${ctx.one ? '未記録が1件' : `未記録が${ctx.count}件`}・${label[ctx.situation]}`;

  const M = window.LATENT_MESSAGES;
  list.innerHTML = SLOT_ORDER.map((k, i) => {
    const on = state.prefs.slots[k].on;
    const line = pickLine(tone, k, ctx, previewSeed + i);
    if (!line) return '';
    const time = state.prefs.slots[k].at;
    return `<div class="notif${on ? '' : ' notif--off'}">
      <div class="notif__icon"></div>
      <div class="notif__text">
        <div class="notif__app"><span>Latent ・ ${M.slotNames[k]}</span><span class="mono">${on ? time : '送らない'}</span></div>
        <p class="notif__title">${esc(line.title)}</p>
        <p class="notif__body">${esc(line.body)}</p>
      </div>
    </div>`;
  }).join('');
}

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('#btn-preview').addEventListener('click', () => {
  previewTone = state.prefs.tone;
  previewSeed = 0;
  renderPreview();
  openScrim('preview');
});

$('#preview-tone').addEventListener('click', e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  previewTone = c.dataset.tone;
  renderPreview();
});

$('#btn-reroll').addEventListener('click', () => { previewSeed++; renderPreview(); });

/* ==========================================================================
   起動
   ========================================================================== */
function sortGoals() {
  state.goals.sort((a, b) => {
    const fa = today() > lastDateOf(a) ? 1 : 0;
    const fb = today() > lastDateOf(b) ? 1 : 0;
    if (fa !== fb) return fa - fb;              // 進行中を上に
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

async function load() {
  state.goals = await dbAll();
  sortGoals();
  await loadPrefs();
}

(async function boot() {
  try {
    await load();
  } catch {
    toast('保存領域を開けませんでした');
  }
  renderList();
  showView('list');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
})();

/* 日付をまたいだら表示を更新する */
let lastSeen = today();
setInterval(() => {
  const t = today();
  if (t === lastSeen) return;
  lastSeen = t;
  if (state.current) { paintTiles(state.current); refreshDetail(); }
  renderList();
}, 60000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = today();
  if (t !== lastSeen) {
    lastSeen = t;
    if (state.current) { paintTiles(state.current); refreshDetail(); }
    renderList();
  }
});

})();
