// 画面遷移・検索・年表描画・フォーム処理をまとめた本体

let eras = [];
let people = [];
let events = [];

let navStack = ['view-search'];
let currentPersonId = null;
let currentEventId = null;
let currentEraId = null;
let editingPersonId = null;
let editingEventId = null;
let editingEraId = null;
let draftParticipants = [];

let mapEditingEventId = null;
let mapDraftShapes = [];
let mapDraftParticipants = [];
let selectedMapTool = null;
let mapDragging = null;

const STATUS_LIST = ['生存', '死亡', '負傷', '不明'];
const STATUS_CLASS = { 生存: 'alive', 死亡: 'dead', 負傷: 'injured', 不明: 'unknown' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function eventTimeKey(ev) { return (ev.year ?? 0) * 100 + (ev.month ?? 0); }
function formatEventTime(ev) { return `${ev.year}年` + (ev.month ? `${ev.month}月` : ''); }

function peopleMapCache() { return new Map(people.map((p) => [p.id, p])); }
function personById(id) { return people.find((p) => p.id === id); }
function eraById(id) { return eras.find((e) => e.id === id); }
function eventById(id) { return events.find((e) => e.id === id); }

async function refreshAll() {
  [eras, people, events] = await Promise.all([DB.getAllEras(), DB.getAllPeople(), DB.getAllEvents()]);
}

// 指定した人物が死亡している出来事があれば、その中で一番年が遅いものを返す
function getDeathInfo(personId) {
  const hits = events.filter((ev) => (ev.participants || []).some((p) => p.personId === personId && p.status === '死亡'));
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => eventTimeKey(b) - eventTimeKey(a))[0];
}

// ===== 画面遷移 =====
function applyView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  const renderFn = RENDER_FNS[viewId];
  if (renderFn) renderFn();
}

function navigateTo(viewId) {
  navStack.push(viewId);
  applyView(viewId);
}

function goBack() {
  if (navStack.length > 1) navStack.pop();
  applyView(navStack[navStack.length - 1]);
}

function switchTab(viewId) {
  navStack = [viewId];
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === viewId));
  applyView(viewId);
}

function openPersonDetail(id) { currentPersonId = id; navigateTo('view-person-detail'); }
function openEventDetail(id) { currentEventId = id; navigateTo('view-event-detail'); }
function openEraDetail(id) { currentEraId = id; navigateTo('view-era-detail'); }

function openPersonForm(id) {
  editingPersonId = id;
  const nameEl = document.getElementById('person-form-name');
  const kanaEl = document.getElementById('person-form-kana');
  const eraEl = document.getElementById('person-form-era');
  const summaryEl = document.getElementById('person-form-summary');
  eraEl.innerHTML = '<option value="">未設定</option>' + eras.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  if (id) {
    const p = personById(id);
    nameEl.value = p.name || '';
    kanaEl.value = p.kana || '';
    eraEl.value = p.eraId ?? '';
    summaryEl.value = p.summary || '';
  } else {
    nameEl.value = ''; kanaEl.value = ''; eraEl.value = ''; summaryEl.value = '';
  }
  navigateTo('view-edit-person');
}

function openEraForm(id) {
  editingEraId = id;
  const nameEl = document.getElementById('era-form-name');
  const startEl = document.getElementById('era-form-start');
  const endEl = document.getElementById('era-form-end');
  const noteEl = document.getElementById('era-form-note');
  if (id) {
    const e = eraById(id);
    nameEl.value = e.name || '';
    startEl.value = e.startYear ?? 0;
    endEl.value = e.endYear ?? 0;
    noteEl.value = e.note || '';
  } else {
    nameEl.value = ''; startEl.value = 0; endEl.value = 0; noteEl.value = '';
  }
  navigateTo('view-edit-era');
}

function openEventForm(id) {
  editingEventId = id;
  const titleEl = document.getElementById('event-form-title');
  const yearEl = document.getElementById('event-form-year');
  const monthEl = document.getElementById('event-form-month');
  const descEl = document.getElementById('event-form-description');
  if (id) {
    const ev = eventById(id);
    titleEl.value = ev.title || '';
    yearEl.value = ev.year ?? '';
    monthEl.value = ev.month ?? '';
    descEl.value = ev.description || '';
    draftParticipants = (ev.participants || []).map((p) => ({ ...p }));
  } else {
    titleEl.value = ''; yearEl.value = ''; monthEl.value = ''; descEl.value = '';
    draftParticipants = [];
  }
  renderEventFormParticipants();
  renderAddPersonSelect();
  navigateTo('view-edit-event');
}

// ===== 検索 =====
function renderSearch() {
  const q = (document.getElementById('search-input').value || '').trim().toLowerCase();
  const listEl = document.getElementById('search-results');
  const emptyEl = document.getElementById('search-empty');
  if (!q) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = '名前を入力すると、人物の経歴を検索できます'; return; }
  const hits = people.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.kana || '').toLowerCase().includes(q));
  if (!hits.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = '該当する人物が見つかりません'; return; }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = hits.map((p) => personListItemHtml(p)).join('');
}

function personListItemHtml(p) {
  const era = eraById(p.eraId);
  const dead = getDeathInfo(p.id);
  return `<li class="list-item" data-person-id="${p.id}">
    <div class="list-item-main">
      <div class="list-item-title">${escapeHtml(p.name)}</div>
      <div class="list-item-sub">${era ? escapeHtml(era.name) : '時代未設定'}${dead ? ' ・ 死亡済' : ''}</div>
    </div>
    ${dead ? '<span class="badge dead">死亡済</span>' : ''}
    <span class="list-item-chevron">›</span>
  </li>`;
}

// ===== 人物一覧 =====
function renderPeople() {
  const listEl = document.getElementById('people-list');
  const emptyEl = document.getElementById('people-empty');
  if (!people.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');
  const sorted = people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  listEl.innerHTML = sorted.map((p) => personListItemHtml(p)).join('');
}

// ===== 人物詳細 =====
function renderPersonDetail() {
  const p = personById(currentPersonId);
  if (!p) { goBack(); return; }
  const era = eraById(p.eraId);
  document.getElementById('person-era-badge').textContent = era ? era.name : '時代未設定';
  document.getElementById('person-name').textContent = p.name;
  document.getElementById('person-kana').textContent = p.kana || '';
  document.getElementById('person-summary').textContent = p.summary || '';

  const death = getDeathInfo(p.id);
  const banner = document.getElementById('person-death-banner');
  if (death) {
    banner.classList.remove('hidden');
    banner.innerHTML = `死亡済: <b>${escapeHtml(death.title)}</b>(${formatEventTime(death)})で死亡 → 出来事を見る`;
    banner.onclick = () => openEventDetail(death.id);
  } else {
    banner.classList.add('hidden');
    banner.onclick = null;
  }

  const myEvents = events.filter((ev) => (ev.participants || []).some((pt) => pt.personId === p.id))
    .slice().sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  const timelineEl = document.getElementById('person-timeline');
  const timelineEmptyEl = document.getElementById('person-timeline-empty');
  if (!myEvents.length) { timelineEl.innerHTML = ''; timelineEmptyEl.classList.remove('hidden'); }
  else {
    timelineEmptyEl.classList.add('hidden');
    timelineEl.innerHTML = myEvents.map((ev) => {
      const part = (ev.participants || []).find((pt) => pt.personId === p.id) || {};
      const isDead = part.status === '死亡';
      return `<li class="timeline-item ${isDead ? 'is-dead' : ''}" data-event-id="${ev.id}">
        <div class="timeline-year">${formatEventTime(ev)}</div>
        <div class="timeline-body">
          <div class="timeline-title">${escapeHtml(ev.title)} <span class="status-pill ${STATUS_CLASS[part.status] || 'unknown'}">${part.status || '不明'}</span></div>
          <div class="timeline-desc">${escapeHtml(part.note || ev.description || '')}</div>
        </div>
      </li>`;
    }).join('');
  }
}

// ===== 出来事一覧 =====
function renderEvents() {
  const listEl = document.getElementById('events-list');
  const emptyEl = document.getElementById('events-empty');
  if (!events.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');
  const sorted = events.slice().sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  listEl.innerHTML = sorted.map((ev) => `<li class="list-item" data-event-id="${ev.id}">
    <div class="list-item-main">
      <div class="list-item-title">${escapeHtml(ev.title)}</div>
      <div class="list-item-sub">${formatEventTime(ev)} ・ 参加者${(ev.participants || []).length}人</div>
    </div>
    <span class="list-item-chevron">›</span>
  </li>`).join('');
}

// ===== 出来事詳細 =====
function renderEventDetail() {
  const ev = eventById(currentEventId);
  if (!ev) { goBack(); return; }
  document.getElementById('event-title').textContent = ev.title;
  document.getElementById('event-year').textContent = formatEventTime(ev);
  document.getElementById('event-description').textContent = ev.description || '';

  const pm = peopleMapCache();
  const listEl = document.getElementById('event-participants');
  listEl.innerHTML = (ev.participants || []).map((p) => {
    const person = pm.get(p.personId);
    return `<li class="list-item" data-person-id="${p.personId}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(person ? person.name : '(不明な人物)')}</div>
        <div class="list-item-sub">${escapeHtml(p.note || '')}</div>
      </div>
      <span class="status-pill ${STATUS_CLASS[p.status] || 'unknown'}">${p.status || '不明'}</span>
      <span class="list-item-chevron">›</span>
    </li>`;
  }).join('');

  const wrap = document.getElementById('event-map-preview-wrap');
  const svg = document.getElementById('event-map-preview');
  const shapes = (ev.terrainMap && ev.terrainMap.shapes) || [];
  const placed = (ev.participants || []).filter((p) => p.position);
  if (shapes.length || placed.length) {
    wrap.style.display = '';
    renderMapSvg(svg, shapes, placed, pm, false);
  } else {
    wrap.style.display = 'none';
  }
}

// ===== 時代一覧 =====
function renderEras() {
  const listEl = document.getElementById('eras-list');
  const emptyEl = document.getElementById('eras-empty');
  if (!eras.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = eras.map((e) => {
    const count = people.filter((p) => p.eraId === e.id).length;
    return `<li class="list-item" data-era-id="${e.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(e.name)}</div>
        <div class="list-item-sub">${e.startYear}年〜${e.endYear}年 ・ 人物${count}人</div>
      </div>
      <span class="list-item-chevron">›</span>
    </li>`;
  }).join('');
}

// ===== 時代詳細 =====
function renderEraDetail() {
  const era = eraById(currentEraId);
  if (!era) { goBack(); return; }
  document.getElementById('era-name').textContent = era.name;
  document.getElementById('era-years').textContent = `${era.startYear}年〜${era.endYear}年`;
  document.getElementById('era-note').textContent = era.note || '';

  const erapeople = people.filter((p) => p.eraId === era.id);
  document.getElementById('era-people').innerHTML = erapeople.length
    ? erapeople.map((p) => personListItemHtml(p)).join('')
    : '<div class="empty-state">この時代の人物はまだいません</div>';

  const eraPersonIds = new Set(erapeople.map((p) => p.id));
  const eraEvents = events.filter((ev) => (ev.participants || []).some((p) => eraPersonIds.has(p.personId)))
    .slice().sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  const el = document.getElementById('era-events');
  el.innerHTML = eraEvents.length ? eraEvents.map((ev) => `<li class="timeline-item" data-event-id="${ev.id}">
      <div class="timeline-year">${formatEventTime(ev)}</div>
      <div class="timeline-body"><div class="timeline-title">${escapeHtml(ev.title)}</div></div>
    </li>`).join('') : '<div class="empty-state">この時代の出来事はまだありません</div>';
}

// ===== 出来事フォーム: 参加者編集 =====
function renderEventFormParticipants() {
  const pm = peopleMapCache();
  const listEl = document.getElementById('event-form-participants');
  listEl.innerHTML = draftParticipants.map((p) => {
    const person = pm.get(p.personId);
    const options = STATUS_LIST.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`).join('');
    return `<li class="participant-row" data-pid="${p.personId}">
      <div class="list-item-main">${escapeHtml(person ? person.name : '(不明)')}</div>
      <select class="pf-status">${options}</select>
      <input class="pf-note" type="text" placeholder="備考" value="${escapeHtml(p.note || '')}">
      <button type="button" class="remove-btn" data-remove="${p.personId}">×</button>
    </li>`;
  }).join('');
}

function renderAddPersonSelect() {
  const sel = document.getElementById('event-form-add-person');
  const addedIds = new Set(draftParticipants.map((p) => p.personId));
  const candidates = people.filter((p) => !addedIds.has(p.id));
  sel.innerHTML = candidates.length
    ? candidates.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">(登録済みの人物がいません)</option>';
}

// ===== 地形配置キャンバス =====
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function hillPoints(cx, cy) {
  return [[cx - 20, cy + 12], [cx - 9, cy - 14], [cx + 9, cy - 14], [cx + 20, cy + 12]];
}

function renderMapSvg(svg, shapes, participants, pm, interactive) {
  svg.innerHTML = '';
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: 400, height: 300, fill: '#dfe8d8' }));
  shapes.forEach((shape, idx) => {
    if (shape.type === 'hill') {
      const pts = hillPoints(shape.x, shape.y).map((p) => p.join(',')).join(' ');
      svg.appendChild(svgEl('polygon', { points: pts, fill: '#8a9a6b', stroke: '#5f6f45', 'stroke-width': 1.5, 'data-kind': 'shape', 'data-shape-idx': idx }));
    } else if (shape.type === 'river') {
      svg.appendChild(svgEl('line', { x1: shape.x - 30, y1: shape.y, x2: shape.x + 30, y2: shape.y, stroke: '#5b8bd0', 'stroke-width': 6, 'stroke-linecap': 'round', 'data-kind': 'shape', 'data-shape-idx': idx }));
    }
  });
  participants.forEach((p, idx) => {
    if (!p.position) return;
    const person = pm.get(p.personId);
    const name = person ? person.name : '?';
    const color = p.status === '死亡' ? '#d1374a' : '#5b37b7';
    const g = svgEl('g', { 'data-kind': 'marker', 'data-participant-idx': idx });
    g.appendChild(svgEl('circle', { cx: p.position.x, cy: p.position.y, r: 14, fill: color, stroke: '#fff', 'stroke-width': 2 }));
    const text = svgEl('text', { x: p.position.x, y: p.position.y + 26, 'text-anchor': 'middle', 'font-size': 11, fill: '#1c1530' });
    text.textContent = name.slice(0, 4);
    g.appendChild(text);
    svg.appendChild(g);
  });
}

function svgPoint(svg, e) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: (e.clientX - rect.left) / rect.width * vb.width + vb.x,
    y: (e.clientY - rect.top) / rect.height * vb.height + vb.y,
  };
}

function redrawMapEditor() {
  const svg = document.getElementById('map-svg');
  renderMapSvg(svg, mapDraftShapes, mapDraftParticipants, peopleMapCache(), true);
}

function renderMapToolbar() {
  const bar = document.getElementById('map-toolbar');
  const tools = [{ id: 'hill', label: '⛰ 山を置く' }, { id: 'river', label: '🌊 川を置く' }, { id: 'delete', label: '🗑 地形を削除' }];
  bar.innerHTML = tools.map((t) => `<button type="button" class="map-tool-btn ${selectedMapTool === t.id ? 'active' : ''}" data-tool="${t.id}">${t.label}</button>`).join('');
}

function openMapEditor() {
  const ev = eventById(mapEditingEventId);
  mapDraftShapes = JSON.parse(JSON.stringify((ev.terrainMap && ev.terrainMap.shapes) || []));
  mapDraftParticipants = JSON.parse(JSON.stringify(ev.participants || [])).map((p, i) => (
    p.position ? p : { ...p, position: { x: 30 + (i % 6) * 58, y: 230 + Math.floor(i / 6) * 40 } }
  ));
  selectedMapTool = null;
  renderMapToolbar();
  redrawMapEditor();
}

function initMapEditorEvents() {
  const svg = document.getElementById('map-svg');
  document.getElementById('map-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    selectedMapTool = selectedMapTool === btn.dataset.tool ? null : btn.dataset.tool;
    renderMapToolbar();
  });
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-kind]');
    if (selectedMapTool === 'delete') {
      if (g && g.dataset.kind === 'shape') { mapDraftShapes.splice(Number(g.dataset.shapeIdx), 1); redrawMapEditor(); }
      return;
    }
    if (g) {
      mapDragging = g.dataset.kind === 'shape'
        ? { kind: 'shape', idx: Number(g.dataset.shapeIdx) }
        : { kind: 'marker', idx: Number(g.dataset.participantIdx) };
      return;
    }
    if (selectedMapTool === 'hill' || selectedMapTool === 'river') {
      const pt = svgPoint(svg, e);
      mapDraftShapes.push({ type: selectedMapTool, x: pt.x, y: pt.y });
      redrawMapEditor();
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!mapDragging) return;
    const pt = svgPoint(svg, e);
    if (mapDragging.kind === 'shape') { mapDraftShapes[mapDragging.idx].x = pt.x; mapDraftShapes[mapDragging.idx].y = pt.y; }
    else { mapDraftParticipants[mapDragging.idx].position = { x: pt.x, y: pt.y }; }
    redrawMapEditor();
  });
  window.addEventListener('pointerup', () => { mapDragging = null; });
  document.getElementById('map-save-btn').addEventListener('click', async () => {
    const ev = eventById(mapEditingEventId);
    ev.terrainMap = { shapes: mapDraftShapes };
    ev.participants = mapDraftParticipants;
    await DB.updateEvent(ev);
    await refreshAll();
    goBack();
  });
}

// ===== 確認シート =====
let pendingConfirm = null;
function askConfirm(fn) {
  pendingConfirm = fn;
  document.getElementById('confirm-sheet').classList.remove('hidden');
}
function hideConfirm() {
  pendingConfirm = null;
  document.getElementById('confirm-sheet').classList.add('hidden');
}

// ===== 保存・削除処理 =====
async function savePersonForm() {
  const name = document.getElementById('person-form-name').value.trim();
  if (!name) { alert('名前を入力してください'); return; }
  const kana = document.getElementById('person-form-kana').value.trim();
  const eraVal = document.getElementById('person-form-era').value;
  const eraId = eraVal ? Number(eraVal) : null;
  const summary = document.getElementById('person-form-summary').value.trim();
  if (editingPersonId) {
    const p = personById(editingPersonId);
    p.name = name; p.kana = kana; p.eraId = eraId; p.summary = summary;
    await DB.updatePerson(p);
  } else {
    const id = await DB.addPerson({ name, kana, eraId, summary, createdAt: Date.now() });
    currentPersonId = id;
  }
  await refreshAll();
  goBack();
}

async function deletePerson(id) {
  for (const ev of events.filter((e) => (e.participants || []).some((p) => p.personId === id))) {
    ev.participants = ev.participants.filter((p) => p.personId !== id);
    await DB.updateEvent(ev);
  }
  await DB.deletePerson(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-person-detail');
  goBack();
}

function clampYear(v) { return Math.min(3000, Math.max(0, Number(v) || 0)); }

async function saveEraForm() {
  const name = document.getElementById('era-form-name').value.trim();
  if (!name) { alert('時代名を入力してください'); return; }
  const startYear = clampYear(document.getElementById('era-form-start').value);
  const endYear = clampYear(document.getElementById('era-form-end').value);
  if (startYear > endYear) { alert('開始年は終了年より前にしてください'); return; }
  const note = document.getElementById('era-form-note').value.trim();
  if (editingEraId) {
    const e = eraById(editingEraId);
    e.name = name; e.startYear = startYear; e.endYear = endYear; e.note = note;
    await DB.updateEra(e);
  } else {
    const id = await DB.addEra({ name, startYear, endYear, note });
    currentEraId = id;
  }
  await refreshAll();
  goBack();
}

async function deleteEra(id) {
  for (const p of people.filter((p) => p.eraId === id)) {
    p.eraId = null;
    await DB.updatePerson(p);
  }
  await DB.deleteEra(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-era-detail');
  goBack();
}

async function saveEventForm() {
  const title = document.getElementById('event-form-title').value.trim();
  if (!title) { alert('出来事を入力してください'); return; }
  const year = clampYear(document.getElementById('event-form-year').value);
  const monthVal = document.getElementById('event-form-month').value;
  const month = monthVal ? Number(monthVal) : null;
  const description = document.getElementById('event-form-description').value.trim();
  if (editingEventId) {
    const ev = eventById(editingEventId);
    ev.title = title; ev.year = year; ev.month = month; ev.description = description; ev.participants = draftParticipants;
    await DB.updateEvent(ev);
    currentEventId = ev.id;
  } else {
    const id = await DB.addEvent({ title, year, month, description, terrainMap: null, participants: draftParticipants });
    currentEventId = id;
  }
  await refreshAll();
  goBack();
}

async function deleteEvent(id) {
  await DB.deleteEvent(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-event-detail');
  goBack();
}

// ===== イベント配線 =====
const RENDER_FNS = {
  'view-search': renderSearch,
  'view-people': renderPeople,
  'view-person-detail': renderPersonDetail,
  'view-events': renderEvents,
  'view-event-detail': renderEventDetail,
  'view-event-map-editor': openMapEditor,
  'view-eras': renderEras,
  'view-era-detail': renderEraDetail,
};

function wireNav() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });
  document.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => goBack()));
  document.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', () => {
    const target = btn.dataset.nav;
    if (btn.dataset.new === 'person') openPersonForm(null);
    else if (btn.dataset.new === 'event') openEventForm(null);
    else if (btn.dataset.new === 'era') openEraForm(null);
    else navigateTo(target);
  }));
}

function wireLists() {
  document.getElementById('search-input').addEventListener('input', renderSearch);

  const delegate = (id, selector, fn) => document.getElementById(id).addEventListener('click', (e) => {
    const el = e.target.closest(selector);
    if (el) fn(el);
  });

  delegate('search-results', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('people-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('era-people', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('event-participants', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('events-list', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('person-timeline', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('era-events', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('eras-list', '[data-era-id]', (el) => openEraDetail(Number(el.dataset.eraId)));
}

function wireDetailActions() {
  document.getElementById('person-edit-btn').addEventListener('click', () => openPersonForm(currentPersonId));
  document.getElementById('person-delete-btn').addEventListener('click', () => askConfirm(() => deletePerson(currentPersonId)));
  document.getElementById('event-edit-btn').addEventListener('click', () => openEventForm(currentEventId));
  document.getElementById('event-delete-btn').addEventListener('click', () => askConfirm(() => deleteEvent(currentEventId)));
  document.getElementById('event-map-btn').addEventListener('click', () => { mapEditingEventId = currentEventId; navigateTo('view-event-map-editor'); });
  document.getElementById('era-edit-btn').addEventListener('click', () => openEraForm(currentEraId));
  document.getElementById('era-delete-btn').addEventListener('click', () => askConfirm(() => deleteEra(currentEraId)));

  document.getElementById('confirm-sheet-ok').addEventListener('click', () => { const fn = pendingConfirm; hideConfirm(); if (fn) fn(); });
  document.getElementById('confirm-sheet-cancel').addEventListener('click', hideConfirm);
  document.getElementById('confirm-sheet').addEventListener('click', (e) => { if (e.target.id === 'confirm-sheet') hideConfirm(); });
}

function wireForms() {
  document.getElementById('person-save-btn').addEventListener('click', savePersonForm);
  document.getElementById('era-save-btn').addEventListener('click', saveEraForm);
  document.getElementById('event-save-btn').addEventListener('click', saveEventForm);

  document.getElementById('event-form-add-btn').addEventListener('click', () => {
    const sel = document.getElementById('event-form-add-person');
    const personId = Number(sel.value);
    if (!personId || draftParticipants.some((p) => p.personId === personId)) return;
    draftParticipants.push({ personId, status: '生存', note: '', position: null });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });

  const participantsList = document.getElementById('event-form-participants');
  participantsList.addEventListener('change', (e) => {
    const row = e.target.closest('.participant-row');
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const draft = draftParticipants.find((p) => p.personId === pid);
    if (!draft) return;
    if (e.target.classList.contains('pf-status')) draft.status = e.target.value;
  });
  participantsList.addEventListener('input', (e) => {
    const row = e.target.closest('.participant-row');
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const draft = draftParticipants.find((p) => p.personId === pid);
    if (!draft) return;
    if (e.target.classList.contains('pf-note')) draft.note = e.target.value;
  });
  participantsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const pid = Number(btn.dataset.remove);
    draftParticipants = draftParticipants.filter((p) => p.personId !== pid);
    renderEventFormParticipants();
    renderAddPersonSelect();
  });
}

function wireBackup() {
  document.getElementById('backup-export-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('backup-status');
    try {
      const result = await Backup.exportFile();
      statusEl.textContent = result.cancelled ? '' : `書き出しました(人物${result.people}件・出来事${result.events}件)`;
    } catch (err) {
      statusEl.textContent = '書き出しに失敗しました: ' + err.message;
    }
  });
  document.getElementById('backup-import-btn').addEventListener('click', () => document.getElementById('backup-import-file').click());
  document.getElementById('backup-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('backup-status');
    try {
      const text = await file.text();
      const data = Backup.parse(text);
      const result = await Backup.restore(data);
      await refreshAll();
      statusEl.textContent = `読み込みました(人物${result.people}件・出来事${result.events}件)`;
    } catch (err) {
      statusEl.textContent = '読み込みに失敗しました: ' + err.message;
    }
    e.target.value = '';
  });
}

// ===== バージョン確認・更新 =====
async function fetchLatestVersion() {
  const res = await fetch(`js/version.js?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('取得できませんでした');
  const text = await res.text();
  const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('バージョンを読み取れませんでした');
  return m[1];
}

// service-worker.js自体は中身(バイト列)が変わらないリリースもあるため、
// ブラウザの自動更新チェックだけでは新しさに気づけない場合がある。
// そのため、新しいバージョンがあると分かったら unregister→再登録して、確実に新しい内容を取りに行かせる
async function applyServiceWorkerUpdate() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) await reg.unregister().catch(() => {});
  await navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

async function checkForUpdate() {
  const statusEl = document.getElementById('update-status');
  const btn = document.getElementById('btn-check-update');
  btn.disabled = true;
  statusEl.textContent = '確認中...';
  try {
    const latest = await fetchLatestVersion();
    if (latest === APP_VERSION) {
      statusEl.textContent = `最新版です(バージョン ${APP_VERSION})`;
    } else {
      autoUpdateNoticeShown = true;
      await applyServiceWorkerUpdate();
      statusEl.textContent = `新しいバージョン(${latest})に更新しました。まもなく画面が更新されます。`;
      setTimeout(() => location.reload(), 600); // メッセージが一瞬見えるよう、少し待ってから更新する
    }
  } catch (err) {
    console.error('バージョン確認に失敗:', err);
    statusEl.textContent = '確認できませんでした。ネット接続を確認してください。';
  } finally {
    btn.disabled = false;
  }
}

let autoUpdateNoticeShown = false;
let autoUpdateCheckInFlight = false;
// アプリを開いた・前面に戻ったときに、裏で静かにバージョンを確認する(ユーザーが設定画面を開く必要がないようにするため)
async function autoCheckUpdateSilently() {
  if (autoUpdateCheckInFlight || autoUpdateNoticeShown) return;
  autoUpdateCheckInFlight = true;
  try {
    const latest = await fetchLatestVersion();
    if (latest !== APP_VERSION) {
      autoUpdateNoticeShown = true;
      await applyServiceWorkerUpdate();
      location.reload();
    }
  } catch (err) { /* オフラインなどはここでは何もしない(設定画面のボタンでエラーを伝える) */ }
  finally { autoUpdateCheckInFlight = false; }
}

function wireUpdateCheck() {
  document.getElementById('btn-check-update').addEventListener('click', checkForUpdate);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoCheckUpdateSilently(); });
}

async function init() {
  await refreshAll();
  wireNav();
  wireLists();
  wireDetailActions();
  wireForms();
  wireBackup();
  wireUpdateCheck();
  initMapEditorEvents();
  document.getElementById('app-version').textContent = APP_VERSION;
  document.getElementById('app-version-home').textContent = 'v' + APP_VERSION;
  applyView('view-search');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
  setTimeout(autoCheckUpdateSilently, 4000); // 起動が落ち着いてから、裏で新しいバージョンがないか確認する
}

document.addEventListener('DOMContentLoaded', init);
