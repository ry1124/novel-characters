// 画面遷移・検索・年表描画・フォーム処理をまとめた本体

let people = [];
let events = [];

let navStack = ['view-search'];
let currentPersonId = null;
let currentEventId = null;
let editingPersonId = null;
let editingEventId = null;
let eventFormParentId = null; // 新規作成する出来事を、どの出来事の子出来事として作るか(null=トップレベル)
let draftParticipants = [];

let mapEditingEventId = null;
let mapDraftShapes = [];
let mapDraftParticipants = [];
let selectedMapTool = null;
let mapDragging = null;

let memoDetectedPersonIds = new Set();
let spouseDraftIds = [];
let familyTreeFocusId = null;

const STATUS_LIST = ['生存', '死亡', '負傷', '不明'];
const STATUS_CLASS = { 生存: 'alive', 死亡: 'dead', 負傷: 'injured', 不明: 'unknown' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function eventTimeKey(ev) { return (ev.year ?? 0) * 100 + (ev.month ?? 0); }
function formatYearMonth(y, m) { return `${y}年` + (m ? `${m}月` : ''); }
function formatEventTime(ev) {
  const start = formatYearMonth(ev.year, ev.month);
  if (ev.endYear == null) return start;
  return `${start}〜${formatYearMonth(ev.endYear, ev.endMonth)}`;
}

function peopleMapCache() { return new Map(people.map((p) => [p.id, p])); }
function personById(id) { return people.find((p) => p.id === id); }
function eventById(id) { return events.find((e) => e.id === id); }

function formatPersonYears(p) {
  if (!p.birthYear && !p.deathYear) return '';
  return `${p.birthYear ?? '?'}年〜${p.deathYear ?? ''}${p.deathYear ? '年' : ''}`;
}

// 生年が分かっている人物だけ、指定した年の時点での年齢(満年齢、月は考慮しない簡易計算)を返す
function personAgeAt(p, year) {
  if (p.birthYear == null || year == null) return null;
  return year - p.birthYear;
}

async function refreshAll() {
  [people, events] = await Promise.all([DB.getAllPeople(), DB.getAllEvents()]);
}

// 指定した人物が死亡している出来事があれば、その中で一番年が遅いものを返す
function getDeathInfo(personId) {
  const hits = events.filter((ev) => (ev.participants || []).some((p) => p.personId === personId && p.status === '死亡'));
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => eventTimeKey(b) - eventTimeKey(a))[0];
}

// 「死亡済」かどうかは、死亡扱いの出来事があるか、没年が手入力されているかのどちらかで判定する
function isPersonDead(p) {
  return getDeathInfo(p.id) !== null || p.deathYear != null;
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

// ===== 人物フォーム: 概要(年表)編集 =====
let summaryDraftRows = [];
let summaryOriginalEventIds = [];
let summaryRowSeq = 0;
function nextSummaryRowId() { return 'r' + (summaryRowSeq++); }

// 「概要」に出す出来事は、この人物だけが参加している(他の人物と共有していない)もの限定。
// 戦いなど複数参加者の出来事は、出来事タブ側でのみ編集する
function loadSummaryRowsForPerson(personId) {
  return events
    .filter((ev) => (ev.participants || []).length === 1 && ev.participants[0].personId === personId)
    .slice().sort((a, b) => eventTimeKey(a) - eventTimeKey(b))
    .map((ev) => ({ rowId: nextSummaryRowId(), eventId: ev.id, year: ev.year, month: ev.month, detail: ev.title }));
}

function renderSummaryList() {
  const listEl = document.getElementById('person-summary-list');
  listEl.innerHTML = summaryDraftRows.map((row) => {
    const options = ['', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => {
      const label = m === '' ? '月-' : `${m}月`;
      return `<option value="${m}" ${Number(row.month) === m || (!row.month && m === '') ? 'selected' : ''}>${label}</option>`;
    }).join('');
    return `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="ps-year" type="number" min="0" max="3000" value="${row.year ?? ''}">
      <select class="ps-month">${options}</select>
      <input class="ps-detail" type="text" value="${escapeHtml(row.detail || '')}" placeholder="詳細">
      <button type="button" class="remove-btn" data-remove-summary="${row.rowId}">×</button>
    </li>`;
  }).join('');
}

// ===== 人物フォーム: 役職(複数・期間あり)編集 =====
// 役職は出来事とは別に、人物に直接 {role, startYear, endYear} の配列として持たせる。
// 年によって変わったり、同時に2つ以上持てたりするため、単一の文字列ではなく配列にしている
let roleDraftRows = [];
let roleRowSeq = 0;
function nextRoleRowId() { return 'role' + (roleRowSeq++); }

function formatRolePeriod(row) {
  return `${row.startYear ?? '?'}年〜${row.endYear != null ? row.endYear + '年' : ''}`;
}

function renderRoleList() {
  const listEl = document.getElementById('person-role-list');
  listEl.innerHTML = roleDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pr-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
      <input class="pr-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
      <input class="pr-name" type="text" value="${escapeHtml(row.role || '')}" placeholder="役職名">
      <button type="button" class="remove-btn" data-remove-role="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 所属(複数・期間あり)編集 =====
// 役職と同じ要領で、人物に直接 {affiliation, startYear, endYear} の配列として持たせる
let affiliationDraftRows = [];
let affiliationRowSeq = 0;
function nextAffiliationRowId() { return 'affiliation' + (affiliationRowSeq++); }

function renderAffiliationList() {
  const listEl = document.getElementById('person-affiliation-list');
  listEl.innerHTML = affiliationDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pa-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
      <input class="pa-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
      <input class="pa-name" type="text" value="${escapeHtml(row.affiliation || '')}" placeholder="所属名">
      <button type="button" class="remove-btn" data-remove-affiliation="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 配偶者(複数)編集 =====
function renderSpouseList() {
  const listEl = document.getElementById('person-spouse-list');
  listEl.innerHTML = spouseDraftIds.map((pid) => {
    const p = personById(pid);
    return `<li class="list-item" data-pid="${pid}">
      <div class="list-item-main"><div class="list-item-title">${escapeHtml(p ? p.name : '?')}</div></div>
      <button type="button" class="remove-btn" data-remove-spouse="${pid}">×</button>
    </li>`;
  }).join('');
}

function renderPersonNameDatalist() {
  document.getElementById('person-name-datalist').innerHTML =
    people.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('');
}

// ===== 人物フォーム: 子・養子(保存済みの人物のみ、その場で関係を更新) =====
function renderChildrenSection() {
  const section = document.getElementById('person-children-section');
  if (!editingPersonId) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const bioChildren = people.filter((c) => c.fatherId === editingPersonId || c.motherId === editingPersonId);
  document.getElementById('person-children-list').innerHTML = bioChildren.map((c) => `<li class="list-item" data-pid="${c.id}">
      <div class="list-item-main"><div class="list-item-title">${escapeHtml(c.name)}</div></div>
      <button type="button" class="remove-btn" data-remove-child="${c.id}">×</button>
    </li>`).join('');

  const adoptedChildren = people.filter((c) => c.adoptiveFatherId === editingPersonId || c.adoptiveMotherId === editingPersonId);
  document.getElementById('person-adopted-children-list').innerHTML = adoptedChildren.map((c) => `<li class="list-item" data-pid="${c.id}">
      <div class="list-item-main"><div class="list-item-title">${escapeHtml(c.name)}</div></div>
      <button type="button" class="remove-btn" data-remove-adopted-child="${c.id}">×</button>
    </li>`).join('');
}

// kind: 'bio' | 'adopted'。子となる人物の父/母(または養父/養母)の欄に、この編集中の人物を設定する
async function addChildRelation(inputId, kind) {
  if (!editingPersonId) return;
  const input = document.getElementById(inputId);
  const name = input.value.trim();
  if (!name) return;
  const focus = personById(editingPersonId);
  const asFather = confirm(`${focus.name}を新しい子の「父」として登録しますか?\n(OK=父として登録／キャンセル=母として登録)`);
  const childId = await resolvePersonByName(name, editingPersonId);
  if (childId === editingPersonId) { input.value = ''; return; } // 自分自身を子にはできない
  const child = await DB.getPerson(childId);
  if (kind === 'bio') {
    if (asFather) child.fatherId = editingPersonId; else child.motherId = editingPersonId;
  } else {
    if (asFather) child.adoptiveFatherId = editingPersonId; else child.adoptiveMotherId = editingPersonId;
  }
  await DB.updatePerson(child);
  await refreshAll();
  input.value = '';
  renderChildrenSection();
  renderPersonNameDatalist();
}

async function removeChildRelation(childId, kind) {
  const child = await DB.getPerson(childId);
  if (!child) return;
  if (kind === 'bio') {
    if (child.fatherId === editingPersonId) child.fatherId = null;
    if (child.motherId === editingPersonId) child.motherId = null;
  } else {
    if (child.adoptiveFatherId === editingPersonId) child.adoptiveFatherId = null;
    if (child.adoptiveMotherId === editingPersonId) child.adoptiveMotherId = null;
  }
  await DB.updatePerson(child);
  await refreshAll();
  renderChildrenSection();
}

// 父・母の欄に入力された名前から人物を探し、見つからなければその場で新しい人物を作る
async function resolvePersonByName(name, excludeId) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const existing = people.find((p) => p.name === trimmed && p.id !== excludeId);
  if (existing) return existing.id;
  const newId = await DB.addPerson({
    name: trimmed, kana: '', youmei: '', maidenName: '', genpukuYear: null, genpukuMonth: null,
    roles: [], affiliations: [], birthYear: null, deathYear: null,
    fatherId: null, motherId: null, adoptiveFatherId: null, adoptiveMotherId: null, spouseIds: [], createdAt: Date.now(),
  });
  people.push({ id: newId, name: trimmed, roles: [], affiliations: [], spouseIds: [] }); // 同じ保存処理内での重複作成を防ぐ(refreshAllで正しい内容に置き換わる)
  return newId;
}

function openPersonForm(id) {
  editingPersonId = id;
  const nameEl = document.getElementById('person-form-name');
  const kanaEl = document.getElementById('person-form-kana');
  const youmeiEl = document.getElementById('person-form-youmei');
  const maidenNameEl = document.getElementById('person-form-maiden-name');
  const genpukuYearEl = document.getElementById('person-form-genpuku-year');
  const genpukuMonthEl = document.getElementById('person-form-genpuku-month');
  const birthEl = document.getElementById('person-form-birth');
  const deathEl = document.getElementById('person-form-death');
  const fatherEl = document.getElementById('person-form-father');
  const motherEl = document.getElementById('person-form-mother');
  if (id) {
    const p = personById(id);
    nameEl.value = p.name || '';
    kanaEl.value = p.kana || '';
    youmeiEl.value = p.youmei || '';
    maidenNameEl.value = p.maidenName || '';
    genpukuYearEl.value = p.genpukuYear ?? '';
    genpukuMonthEl.value = p.genpukuMonth ?? '';
    birthEl.value = p.birthYear ?? '';
    deathEl.value = p.deathYear ?? '';
    summaryDraftRows = loadSummaryRowsForPerson(id);
    roleDraftRows = (p.roles || []).map((r) => ({ rowId: nextRoleRowId(), role: r.role, startYear: r.startYear, endYear: r.endYear }));
    affiliationDraftRows = (p.affiliations || []).map((a) => ({ rowId: nextAffiliationRowId(), affiliation: a.affiliation, startYear: a.startYear, endYear: a.endYear }));
    fatherEl.value = p.fatherId != null ? (personById(p.fatherId)?.name || '') : '';
    motherEl.value = p.motherId != null ? (personById(p.motherId)?.name || '') : '';
    spouseDraftIds = (p.spouseIds || []).slice();
  } else {
    nameEl.value = ''; kanaEl.value = ''; youmeiEl.value = ''; maidenNameEl.value = '';
    genpukuYearEl.value = ''; genpukuMonthEl.value = ''; birthEl.value = ''; deathEl.value = '';
    summaryDraftRows = [];
    roleDraftRows = [];
    affiliationDraftRows = [];
    fatherEl.value = '';
    motherEl.value = '';
    spouseDraftIds = [];
  }
  renderPersonNameDatalist();
  summaryOriginalEventIds = summaryDraftRows.map((r) => r.eventId);
  document.getElementById('person-summary-add-year').value = '';
  document.getElementById('person-summary-add-month').value = '';
  document.getElementById('person-summary-add-detail').value = '';
  document.getElementById('person-role-add-start').value = '';
  document.getElementById('person-role-add-end').value = '';
  document.getElementById('person-role-add-name').value = '';
  document.getElementById('person-affiliation-add-start').value = '';
  document.getElementById('person-affiliation-add-end').value = '';
  document.getElementById('person-affiliation-add-name').value = '';
  renderSummaryList();
  renderRoleList();
  renderAffiliationList();
  renderSpouseList();
  renderChildrenSection();
  navigateTo('view-edit-person');
}

function openEventForm(id, parentId) {
  editingEventId = id;
  const titleEl = document.getElementById('event-form-title');
  const yearEl = document.getElementById('event-form-year');
  const monthEl = document.getElementById('event-form-month');
  const endYearEl = document.getElementById('event-form-end-year');
  const endMonthEl = document.getElementById('event-form-end-month');
  const descEl = document.getElementById('event-form-description');
  if (id) {
    const ev = eventById(id);
    titleEl.value = ev.title || '';
    yearEl.value = ev.year ?? '';
    monthEl.value = ev.month ?? '';
    endYearEl.value = ev.endYear ?? '';
    endMonthEl.value = ev.endMonth ?? '';
    descEl.value = ev.description || '';
    draftParticipants = (ev.participants || []).map((p) => ({ ...p }));
    eventFormParentId = ev.parentEventId ?? null;
  } else {
    titleEl.value = ''; yearEl.value = ''; monthEl.value = '';
    endYearEl.value = ''; endMonthEl.value = ''; descEl.value = '';
    draftParticipants = [];
    eventFormParentId = parentId ?? null;
  }
  const parentNoteEl = document.getElementById('event-form-parent-note');
  const parentEvent = eventFormParentId != null ? eventById(eventFormParentId) : null;
  parentNoteEl.textContent = parentEvent ? `「${parentEvent.title}」の子出来事として登録されます` : '';
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
  const hits = people.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.kana || '').toLowerCase().includes(q)
    || (p.youmei || '').toLowerCase().includes(q) || (p.maidenName || '').toLowerCase().includes(q)
    || (p.roles || []).some((r) => (r.role || '').toLowerCase().includes(q))
    || (p.affiliations || []).some((a) => (a.affiliation || '').toLowerCase().includes(q)));
  if (!hits.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = '該当する人物が見つかりません'; return; }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = hits.map((p) => personListItemHtml(p)).join('');
}

function personListItemHtml(p) {
  const dead = isPersonDead(p);
  const years = formatPersonYears(p);
  const roleNames = (p.roles || []).map((r) => r.role).filter(Boolean).join('・');
  const subParts = [roleNames, years || '生没年未設定'].filter(Boolean);
  return `<li class="list-item" data-person-id="${p.id}">
    <div class="list-item-main">
      <div class="list-item-title">${escapeHtml(p.name)}</div>
      <div class="list-item-sub">${escapeHtml(subParts.join(' ・ '))}${dead ? ' ・ 死亡済' : ''}</div>
    </div>
    ${dead ? '<span class="badge dead">死亡済</span>' : ''}
    <span class="list-item-chevron">›</span>
  </li>`;
}

// ===== 人物一覧 =====
let peopleSortMode = 'name'; // 'name' | 'birth'
function renderPeople() {
  const listEl = document.getElementById('people-list');
  const emptyEl = document.getElementById('people-empty');
  if (!people.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');
  const sorted = people.slice().sort((a, b) => (
    peopleSortMode === 'birth'
      ? (a.birthYear ?? Infinity) - (b.birthYear ?? Infinity)
      : (a.name || '').localeCompare(b.name || '', 'ja')
  ));
  listEl.innerHTML = sorted.map((p) => personListItemHtml(p)).join('');
}

// ===== 人物詳細 =====
function renderPersonDetail() {
  const p = personById(currentPersonId);
  if (!p) { goBack(); return; }
  document.getElementById('person-name').textContent = p.name;
  document.getElementById('person-kana').textContent = p.kana || '';
  document.getElementById('person-youmei').textContent = p.youmei ? `幼名: ${p.youmei}` : '';
  document.getElementById('person-maiden-name').textContent = p.maidenName ? `旧姓: ${p.maidenName}` : '';
  document.getElementById('person-genpuku').textContent = p.genpukuYear != null ? `元服: ${formatYearMonth(p.genpukuYear, p.genpukuMonth)}` : '';
  const rolesSorted = (p.roles || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  document.getElementById('person-roles-timeline').innerHTML = rolesSorted.map((r) => `<li class="timeline-item">
      <div class="timeline-year">${formatRolePeriod(r)}</div>
      <div class="timeline-body"><div class="timeline-title">${escapeHtml(r.role)}</div></div>
    </li>`).join('');
  document.getElementById('person-affiliations').textContent = (p.affiliations || []).map((a) => `${a.affiliation}(${formatRolePeriod(a)})`).join('、');
  document.getElementById('person-years').textContent = formatPersonYears(p);

  const death = getDeathInfo(p.id);
  const banner = document.getElementById('person-death-banner');
  if (death) {
    banner.classList.remove('hidden');
    banner.innerHTML = `死亡済: <b>${escapeHtml(death.title)}</b>(${formatEventTime(death)})で死亡 → 出来事を見る`;
    banner.onclick = () => openEventDetail(death.id);
  } else if (p.deathYear != null) {
    banner.classList.remove('hidden');
    banner.innerHTML = `死亡済(没年 ${p.deathYear}年)`;
    banner.onclick = null;
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
      const age = personAgeAt(p, ev.year);
      return `<li class="timeline-item ${isDead ? 'is-dead' : ''}" data-event-id="${ev.id}">
        <div class="timeline-year">${formatEventTime(ev)}${age !== null ? `(${age}歳)` : ''}</div>
        <div class="timeline-body">
          <div class="timeline-title">${escapeHtml(ev.title)} <span class="status-pill ${STATUS_CLASS[part.status] || 'unknown'}">${part.status || '不明'}</span></div>
          <div class="timeline-desc">${escapeHtml(part.note || ev.description || '')}</div>
        </div>
      </li>`;
    }).join('');
  }
}

// ===== 出来事一覧 =====
function eventMatchesQuery(ev, q) {
  return (ev.title || '').toLowerCase().includes(q) || (ev.description || '').toLowerCase().includes(q);
}

function eventListItemHtml(ev, indent) {
  return `<li class="list-item ${indent ? 'list-item-indent' : ''}" data-event-id="${ev.id}">
    <div class="list-item-main">
      <div class="list-item-title">${indent ? '↳ ' : ''}${escapeHtml(ev.title)}</div>
      <div class="list-item-sub">${formatEventTime(ev)} ・ 参加者${(ev.participants || []).length}人</div>
    </div>
    <span class="list-item-chevron">›</span>
  </li>`;
}

function renderEvents() {
  const listEl = document.getElementById('events-list');
  const emptyEl = document.getElementById('events-empty');
  if (!events.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = 'まだ出来事が登録されていません'; return; }
  const q = (document.getElementById('events-search-input').value || '').trim().toLowerCase();
  const topEvents = events.filter((ev) => ev.parentEventId == null);
  const childrenOf = (id) => events.filter((ev) => ev.parentEventId === id).sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  const filtered = q
    ? topEvents.filter((top) => eventMatchesQuery(top, q) || childrenOf(top.id).some((c) => eventMatchesQuery(c, q)))
    : topEvents;
  if (!filtered.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = '該当する出来事が見つかりません'; return; }
  emptyEl.classList.add('hidden');
  const sorted = filtered.slice().sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  listEl.innerHTML = sorted.map((ev) =>
    eventListItemHtml(ev, false) + childrenOf(ev.id).map((c) => eventListItemHtml(c, true)).join('')
  ).join('');
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
    const age = person ? personAgeAt(person, ev.year) : null;
    const killed = p.killedPersonId != null ? pm.get(p.killedPersonId) : null;
    const subParts = [age !== null ? `${age}歳` : '', killed ? `${killed.name}を討ち取った` : '', p.note || ''].filter(Boolean);
    return `<li class="list-item" data-person-id="${p.personId}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(person ? person.name : '(不明な人物)')}</div>
        <div class="list-item-sub">${escapeHtml(subParts.join(' ・ '))}</div>
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

  const children = events.filter((c) => c.parentEventId === ev.id).sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  document.getElementById('event-children-list').innerHTML = children.map((c) => `<li class="list-item" data-event-id="${c.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(c.title)}</div>
        <div class="list-item-sub">${formatEventTime(c)} ・ 参加者${(c.participants || []).length}人</div>
      </div>
      <span class="list-item-chevron">›</span>
    </li>`).join('');
}

// ===== 出来事フォーム: 参加者編集 =====
function renderEventFormParticipants() {
  const pm = peopleMapCache();
  const listEl = document.getElementById('event-form-participants');
  listEl.innerHTML = draftParticipants.map((p) => {
    const person = pm.get(p.personId);
    const options = STATUS_LIST.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`).join('');
    const killOptions = ['<option value="">討ち取った相手-</option>']
      .concat(draftParticipants.filter((o) => o.personId !== p.personId).map((o) => {
        const op = pm.get(o.personId);
        return `<option value="${o.personId}" ${p.killedPersonId === o.personId ? 'selected' : ''}>${escapeHtml(op ? op.name : '?')}</option>`;
      })).join('');
    return `<li class="participant-row-wrap" data-pid="${p.personId}">
      <div class="participant-row-top">
        <div class="list-item-main">${escapeHtml(person ? person.name : '(不明)')}</div>
        <select class="pf-status">${options}</select>
        <button type="button" class="remove-btn" data-remove="${p.personId}">×</button>
      </div>
      <div class="participant-row-bottom">
        <select class="pf-kill">${killOptions}</select>
        <input class="pf-note" type="text" placeholder="備考" value="${escapeHtml(p.note || '')}">
      </div>
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
function clampYear(v) { return Math.min(3000, Math.max(0, Number(v) || 0)); }

// 概要(年表)の各行を、この人物を唯一の参加者とする「出来事」として作成・更新・削除する
async function syncSummaryRows(personId) {
  const keepEventIds = new Set();
  for (const row of summaryDraftRows) {
    const detail = (row.detail || '').trim();
    if (!detail) continue;
    const year = clampYear(row.year);
    const month = row.month ? Number(row.month) : null;
    if (row.eventId) {
      const ev = eventById(row.eventId);
      if (ev) {
        ev.title = detail; ev.year = year; ev.month = month;
        await DB.updateEvent(ev);
        keepEventIds.add(row.eventId);
        continue;
      }
    }
    const newId = await DB.addEvent({
      title: detail, year, month, endYear: null, endMonth: null, description: '',
      terrainMap: null, participants: [{ personId, status: '生存', note: '', position: null, killedPersonId: null }],
      parentEventId: null,
    });
    keepEventIds.add(newId);
  }
  for (const oldId of summaryOriginalEventIds) {
    if (!keepEventIds.has(oldId)) await DB.deleteEvent(oldId);
  }
}

async function savePersonForm() {
  const name = document.getElementById('person-form-name').value.trim();
  if (!name) { alert('名前を入力してください'); return; }
  const kana = document.getElementById('person-form-kana').value.trim();
  const youmei = document.getElementById('person-form-youmei').value.trim();
  const maidenName = document.getElementById('person-form-maiden-name').value.trim();
  const genpukuYearVal = document.getElementById('person-form-genpuku-year').value;
  const genpukuMonthVal = document.getElementById('person-form-genpuku-month').value;
  const genpukuYear = genpukuYearVal ? clampYear(genpukuYearVal) : null;
  const genpukuMonth = genpukuMonthVal ? Number(genpukuMonthVal) : null;
  const birthVal = document.getElementById('person-form-birth').value;
  const deathVal = document.getElementById('person-form-death').value;
  const birthYear = birthVal ? clampYear(birthVal) : null;
  const deathYear = deathVal ? clampYear(deathVal) : null;
  if (birthYear !== null && deathYear !== null && birthYear > deathYear) { alert('生年は没年より前にしてください'); return; }
  const roles = roleDraftRows
    .filter((r) => (r.role || '').trim())
    .map((r) => ({
      role: r.role.trim(),
      startYear: r.startYear != null && r.startYear !== '' ? clampYear(r.startYear) : null,
      endYear: r.endYear != null && r.endYear !== '' ? clampYear(r.endYear) : null,
    }));
  const affiliations = affiliationDraftRows
    .filter((a) => (a.affiliation || '').trim())
    .map((a) => ({
      affiliation: a.affiliation.trim(),
      startYear: a.startYear != null && a.startYear !== '' ? clampYear(a.startYear) : null,
      endYear: a.endYear != null && a.endYear !== '' ? clampYear(a.endYear) : null,
    }));
  const fatherNameVal = document.getElementById('person-form-father').value;
  const motherNameVal = document.getElementById('person-form-mother').value;
  const fatherId = await resolvePersonByName(fatherNameVal, editingPersonId);
  const motherId = await resolvePersonByName(motherNameVal, editingPersonId);
  const spouseIds = spouseDraftIds.slice();
  let personId = editingPersonId;
  let oldSpouseIds = [];
  if (editingPersonId) {
    const p = personById(editingPersonId);
    oldSpouseIds = p.spouseIds || [];
    p.name = name; p.kana = kana; p.youmei = youmei; p.maidenName = maidenName; p.genpukuYear = genpukuYear; p.genpukuMonth = genpukuMonth;
    p.roles = roles; p.affiliations = affiliations; p.birthYear = birthYear; p.deathYear = deathYear;
    p.fatherId = fatherId; p.motherId = motherId; p.spouseIds = spouseIds;
    await DB.updatePerson(p);
  } else {
    personId = await DB.addPerson({ name, kana, youmei, maidenName, genpukuYear, genpukuMonth, roles, affiliations, birthYear, deathYear, fatherId, motherId, spouseIds, createdAt: Date.now() });
    currentPersonId = personId;
  }
  await syncSpouseLinks(personId, oldSpouseIds, spouseIds);
  await syncSummaryRows(personId);
  await refreshAll();
  goBack();
}

// 配偶者は双方向に持たせる。片方で追加/削除したら、もう片方のspouseIdsにも自動反映する
async function syncSpouseLinks(personId, oldIds, newIds) {
  const oldSet = new Set(oldIds || []);
  const newSet = new Set(newIds || []);
  for (const sid of newSet) {
    if (oldSet.has(sid)) continue;
    const sp = people.find((p) => p.id === sid);
    if (sp && !(sp.spouseIds || []).includes(personId)) {
      sp.spouseIds = [...(sp.spouseIds || []), personId];
      await DB.updatePerson(sp);
    }
  }
  for (const sid of oldSet) {
    if (newSet.has(sid)) continue;
    const sp = people.find((p) => p.id === sid);
    if (sp) {
      sp.spouseIds = (sp.spouseIds || []).filter((x) => x !== personId);
      await DB.updatePerson(sp);
    }
  }
}

async function deletePerson(id) {
  for (const ev of events.filter((e) => (e.participants || []).some((p) => p.personId === id))) {
    ev.participants = ev.participants.filter((p) => p.personId !== id);
    if (ev.participants.length === 0) await DB.deleteEvent(ev.id); // 参加者がいなくなる出来事(概要由来など)は残さない
    else await DB.updateEvent(ev);
  }
  // 他の人物の父・母・配偶者としての参照も外す
  for (const other of people) {
    let changed = false;
    if (other.fatherId === id) { other.fatherId = null; changed = true; }
    if (other.motherId === id) { other.motherId = null; changed = true; }
    if (other.adoptiveFatherId === id) { other.adoptiveFatherId = null; changed = true; }
    if (other.adoptiveMotherId === id) { other.adoptiveMotherId = null; changed = true; }
    if ((other.spouseIds || []).includes(id)) { other.spouseIds = other.spouseIds.filter((x) => x !== id); changed = true; }
    if (changed) await DB.updatePerson(other);
  }
  await DB.deletePerson(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-person-detail');
  goBack();
}

async function saveEventForm() {
  const title = document.getElementById('event-form-title').value.trim();
  if (!title) { alert('出来事を入力してください'); return; }
  const year = clampYear(document.getElementById('event-form-year').value);
  const monthVal = document.getElementById('event-form-month').value;
  const month = monthVal ? Number(monthVal) : null;
  const endYearVal = document.getElementById('event-form-end-year').value;
  const endYear = endYearVal ? clampYear(endYearVal) : null;
  const endMonthVal = document.getElementById('event-form-end-month').value;
  const endMonth = endMonthVal ? Number(endMonthVal) : null;
  if (endYear !== null && (year * 100 + (month || 0)) > (endYear * 100 + (endMonth || 0))) {
    alert('終了時期は開始時期より後にしてください'); return;
  }
  const description = document.getElementById('event-form-description').value.trim();
  if (editingEventId) {
    const ev = eventById(editingEventId);
    ev.title = title; ev.year = year; ev.month = month; ev.endYear = endYear; ev.endMonth = endMonth;
    ev.description = description; ev.participants = draftParticipants;
    await DB.updateEvent(ev);
    currentEventId = ev.id;
  } else {
    const id = await DB.addEvent({ title, year, month, endYear, endMonth, description, terrainMap: null, participants: draftParticipants, parentEventId: eventFormParentId });
    currentEventId = id;
  }
  await refreshAll();
  goBack();
}

async function deleteEvent(id) {
  // 子出来事は消さず、トップレベルに昇格させる(データを失わないため)
  for (const child of events.filter((c) => c.parentEventId === id)) {
    child.parentEventId = null;
    await DB.updateEvent(child);
  }
  await DB.deleteEvent(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-event-detail');
  goBack();
}

// ===== イベント配線 =====
// ===== メモから出来事を作成 =====
function openMemoImport() {
  document.getElementById('memo-text').value = '';
  memoDetectedPersonIds = new Set();
  renderMemoDetectedList();
}

function detectPeopleInMemo() {
  const text = document.getElementById('memo-text').value;
  memoDetectedPersonIds = new Set(
    people.filter((p) => [p.name, p.kana, p.youmei, p.maidenName].filter(Boolean).some((n) => text.includes(n))).map((p) => p.id)
  );
  renderMemoDetectedList();
}

function renderMemoDetectedList() {
  const listEl = document.getElementById('memo-detected-list');
  const emptyEl = document.getElementById('memo-detected-empty');
  if (memoDetectedPersonIds.size === 0) {
    listEl.innerHTML = '';
    emptyEl.textContent = '人物が見つかりませんでした(下の「手動で追加」からも追加できます)';
  } else {
    emptyEl.textContent = '';
    listEl.innerHTML = Array.from(memoDetectedPersonIds).map((pid) => {
      const p = personById(pid);
      return `<li class="list-item" data-pid="${pid}">
        <div class="list-item-main"><div class="list-item-title">${escapeHtml(p ? p.name : '?')}</div></div>
        <button type="button" class="remove-btn" data-remove-memo="${pid}">×</button>
      </li>`;
    }).join('');
  }
  renderMemoAddPersonSelect();
}

function renderMemoAddPersonSelect() {
  const sel = document.getElementById('memo-add-person');
  const candidates = people.filter((p) => !memoDetectedPersonIds.has(p.id));
  sel.innerHTML = candidates.length
    ? candidates.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">(追加できる人物がいません)</option>';
}

function createEventFromMemo() {
  const memo = document.getElementById('memo-text').value.trim();
  editingEventId = null;
  eventFormParentId = null;
  document.getElementById('event-form-parent-note').textContent = '';
  document.getElementById('event-form-title').value = '';
  document.getElementById('event-form-year').value = '';
  document.getElementById('event-form-month').value = '';
  document.getElementById('event-form-end-year').value = '';
  document.getElementById('event-form-end-month').value = '';
  document.getElementById('event-form-description').value = memo;
  draftParticipants = Array.from(memoDetectedPersonIds).map((pid) => ({ personId: pid, status: '生存', note: '', position: null, killedPersonId: null }));
  renderEventFormParticipants();
  renderAddPersonSelect();
  navigateTo('view-edit-event');
}

// ===== 家系図 =====
function treeBoxHtml(person, extraClass, subText) {
  if (!person) return '';
  return `<button type="button" class="tree-box ${extraClass || ''}" data-tree-person="${person.id}">
    ${escapeHtml(person.name)}
    ${subText ? `<div class="tree-box-sub">${escapeHtml(subText)}</div>` : ''}
  </button>`;
}

function treeAddButtonHtml(relation, label) {
  return `<button type="button" class="tree-box add" data-tree-add="${relation}">+ ${escapeHtml(label)}</button>`;
}

function openFamilyTree(id) {
  familyTreeFocusId = id;
  renderFamilyTree();
}

function renderFamilyTree() {
  const p = personById(familyTreeFocusId);
  if (!p) { goBack(); return; }

  const father = p.fatherId != null ? personById(p.fatherId) : null;
  const mother = p.motherId != null ? personById(p.motherId) : null;
  document.getElementById('tree-parents').innerHTML =
    (father ? treeBoxHtml(father, '', '父') : treeAddButtonHtml('father', '父を追加'))
    + (mother ? treeBoxHtml(mother, '', '母') : treeAddButtonHtml('mother', '母を追加'));

  const siblings = people.filter((c) => c.id !== p.id
    && ((p.fatherId != null && c.fatherId === p.fatherId) || (p.motherId != null && c.motherId === p.motherId)));
  document.getElementById('tree-siblings').innerHTML = siblings.map((s) => {
    const sameFather = p.fatherId != null && s.fatherId === p.fatherId;
    const sameMother = p.motherId != null && s.motherId === p.motherId;
    const label = sameFather && sameMother ? '兄弟姉妹' : sameFather ? '異母兄弟姉妹' : '異父兄弟姉妹';
    return treeBoxHtml(s, '', label);
  }).join('') + treeAddButtonHtml('sibling', '兄弟姉妹を追加');

  const spouses = (p.spouseIds || []).map((sid) => personById(sid)).filter(Boolean);
  document.getElementById('tree-self').innerHTML = treeBoxHtml(p, 'self', formatPersonYears(p))
    + spouses.map((sp) => treeBoxHtml(sp, '', '配偶者')).join('')
    + treeAddButtonHtml('spouse', '配偶者を追加');

  const bioChildren = people.filter((c) => c.fatherId === p.id || c.motherId === p.id).map((c) => ({ c, label: formatPersonYears(c) }));
  const adoptedChildren = people.filter((c) => c.adoptiveFatherId === p.id || c.adoptiveMotherId === p.id).map((c) => ({ c, label: '養子' }));
  document.getElementById('tree-children').innerHTML =
    bioChildren.concat(adoptedChildren).map(({ c, label }) => treeBoxHtml(c, '', label)).join('')
    + treeAddButtonHtml('child', '子を追加');
}

// 家系図の画面から、その場で新しい人物を作って関係を結ぶ(父・母・配偶者・子)
async function treeAddPerson(relation) {
  const focus = personById(familyTreeFocusId);
  if (!focus) return;
  const name = (prompt('新しい人物の名前を入力してください') || '').trim();
  if (!name) return;
  const base = { name, kana: '', youmei: '', roles: [], affiliations: [], birthYear: null, deathYear: null, fatherId: null, motherId: null, adoptiveFatherId: null, adoptiveMotherId: null, spouseIds: [], createdAt: Date.now() };

  if (relation === 'father') {
    const newId = await DB.addPerson(base);
    focus.fatherId = newId;
    await DB.updatePerson(focus);
  } else if (relation === 'mother') {
    const newId = await DB.addPerson(base);
    focus.motherId = newId;
    await DB.updatePerson(focus);
  } else if (relation === 'spouse') {
    const newId = await DB.addPerson({ ...base, spouseIds: [focus.id] });
    focus.spouseIds = [...(focus.spouseIds || []), newId];
    await DB.updatePerson(focus);
  } else if (relation === 'sibling') {
    // 本人と同じ父・母を持つ兄弟姉妹として登録する(父母が未設定ならそのまま空欄になる)
    await DB.addPerson({ ...base, fatherId: focus.fatherId ?? null, motherId: focus.motherId ?? null });
  } else if (relation === 'child') {
    const asFather = confirm(`${focus.name}を新しい人物の「父」として登録しますか?\n(OK=父として登録／キャンセル=母として登録)`);
    const isAdopted = confirm('養子として登録しますか?\n(OK=養子として登録／キャンセル=実子として登録)');
    const childData = isAdopted
      ? { ...base, adoptiveFatherId: asFather ? focus.id : null, adoptiveMotherId: asFather ? null : focus.id }
      : { ...base, fatherId: asFather ? focus.id : null, motherId: asFather ? null : focus.id };
    await DB.addPerson(childData);
  }
  await refreshAll();
  renderFamilyTree();
}

const RENDER_FNS = {
  'view-search': renderSearch,
  'view-people': renderPeople,
  'view-person-detail': renderPersonDetail,
  'view-events': renderEvents,
  'view-event-detail': renderEventDetail,
  'view-event-map-editor': openMapEditor,
  'view-memo-import': openMemoImport,
  'view-family-tree': renderFamilyTree,
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
    else navigateTo(target);
  }));
}

function wireLists() {
  document.getElementById('search-input').addEventListener('input', renderSearch);
  document.getElementById('events-search-input').addEventListener('input', renderEvents);

  document.querySelectorAll('#view-people .filter-chips').forEach((bar) => bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sort]');
    if (!chip) return;
    peopleSortMode = chip.dataset.sort;
    bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderPeople();
  }));

  const delegate = (id, selector, fn) => document.getElementById(id).addEventListener('click', (e) => {
    const el = e.target.closest(selector);
    if (el) fn(el);
  });

  delegate('search-results', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('people-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('event-participants', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('events-list', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('event-children-list', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('person-timeline', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
}

function wireDetailActions() {
  document.getElementById('person-edit-btn').addEventListener('click', () => openPersonForm(currentPersonId));
  document.getElementById('person-delete-btn').addEventListener('click', () => askConfirm(() => deletePerson(currentPersonId)));
  document.getElementById('event-edit-btn').addEventListener('click', () => openEventForm(currentEventId));
  document.getElementById('event-delete-btn').addEventListener('click', () => askConfirm(() => deleteEvent(currentEventId)));
  document.getElementById('event-map-btn').addEventListener('click', () => { mapEditingEventId = currentEventId; navigateTo('view-event-map-editor'); });
  document.getElementById('event-add-child-btn').addEventListener('click', () => openEventForm(null, currentEventId));
  document.getElementById('person-tree-btn').addEventListener('click', () => { familyTreeFocusId = currentPersonId; navigateTo('view-family-tree'); });
  document.getElementById('tree-edit-btn').addEventListener('click', () => openPersonForm(familyTreeFocusId));
  document.getElementById('view-family-tree').addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-tree-add]');
    if (addBtn) { treeAddPerson(addBtn.dataset.treeAdd); return; }
    const box = e.target.closest('[data-tree-person]');
    if (!box) return;
    familyTreeFocusId = Number(box.dataset.treePerson);
    renderFamilyTree();
  });

  document.getElementById('confirm-sheet-ok').addEventListener('click', () => { const fn = pendingConfirm; hideConfirm(); if (fn) fn(); });
  document.getElementById('confirm-sheet-cancel').addEventListener('click', hideConfirm);
  document.getElementById('confirm-sheet').addEventListener('click', (e) => { if (e.target.id === 'confirm-sheet') hideConfirm(); });
}

function wireForms() {
  document.getElementById('person-save-btn').addEventListener('click', savePersonForm);
  document.getElementById('event-save-btn').addEventListener('click', saveEventForm);

  document.getElementById('event-form-add-btn').addEventListener('click', () => {
    const sel = document.getElementById('event-form-add-person');
    const personId = Number(sel.value);
    if (!personId || draftParticipants.some((p) => p.personId === personId)) return;
    draftParticipants.push({ personId, status: '生存', note: '', position: null, killedPersonId: null });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });

  document.getElementById('event-form-new-person-btn').addEventListener('click', async () => {
    const name = (prompt('新しい人物の名前を入力してください') || '').trim();
    if (!name) return;
    const personId = await DB.addPerson({ name, kana: '', youmei: '', roles: [], birthYear: null, deathYear: null, createdAt: Date.now() });
    await refreshAll();
    draftParticipants.push({ personId, status: '生存', note: '', position: null, killedPersonId: null });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });

  const participantsList = document.getElementById('event-form-participants');
  participantsList.addEventListener('change', (e) => {
    const row = e.target.closest('.participant-row-wrap');
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const draft = draftParticipants.find((p) => p.personId === pid);
    if (!draft) return;
    if (e.target.classList.contains('pf-status')) {
      draft.status = e.target.value;
    } else if (e.target.classList.contains('pf-kill')) {
      draft.killedPersonId = e.target.value ? Number(e.target.value) : null;
      if (draft.killedPersonId !== null) {
        // 「討ち取った相手」を選ぶと、その相手の生死を自動で「死亡」にする
        const victim = draftParticipants.find((p) => p.personId === draft.killedPersonId);
        if (victim) victim.status = '死亡';
      }
      renderEventFormParticipants(); // 相手側のステータス表示を更新するため再描画
      return;
    }
  });
  participantsList.addEventListener('input', (e) => {
    const row = e.target.closest('.participant-row-wrap');
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
    draftParticipants.forEach((p) => { if (p.killedPersonId === pid) p.killedPersonId = null; });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });

  document.getElementById('person-summary-add-btn').addEventListener('click', () => {
    const yearEl = document.getElementById('person-summary-add-year');
    const monthEl = document.getElementById('person-summary-add-month');
    const detailEl = document.getElementById('person-summary-add-detail');
    const detail = detailEl.value.trim();
    if (!detail) return;
    summaryDraftRows.push({
      rowId: nextSummaryRowId(), eventId: null,
      year: clampYear(yearEl.value), month: monthEl.value ? Number(monthEl.value) : null, detail,
    });
    yearEl.value = ''; monthEl.value = ''; detailEl.value = '';
    renderSummaryList();
  });

  const summaryList = document.getElementById('person-summary-list');
  summaryList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = summaryDraftRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('ps-year')) draft.year = clampYear(e.target.value);
    else if (e.target.classList.contains('ps-detail')) draft.detail = e.target.value;
  });
  summaryList.addEventListener('change', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = summaryDraftRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('ps-month')) draft.month = e.target.value ? Number(e.target.value) : null;
  });
  summaryList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-summary]');
    if (!btn) return;
    summaryDraftRows = summaryDraftRows.filter((r) => r.rowId !== btn.dataset.removeSummary);
    renderSummaryList();
  });

  document.getElementById('person-role-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-role-add-start');
    const endEl = document.getElementById('person-role-add-end');
    const nameEl = document.getElementById('person-role-add-name');
    const role = nameEl.value.trim();
    if (!role) return;
    roleDraftRows.push({
      rowId: nextRoleRowId(), role,
      startYear: startEl.value ? clampYear(startEl.value) : null,
      endYear: endEl.value ? clampYear(endEl.value) : null,
    });
    startEl.value = ''; endEl.value = ''; nameEl.value = '';
    renderRoleList();
  });

  const roleList = document.getElementById('person-role-list');
  roleList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = roleDraftRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pr-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pr-end')) draft.endYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pr-name')) draft.role = e.target.value;
  });
  roleList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-role]');
    if (!btn) return;
    roleDraftRows = roleDraftRows.filter((r) => r.rowId !== btn.dataset.removeRole);
    renderRoleList();
  });

  document.getElementById('person-affiliation-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-affiliation-add-start');
    const endEl = document.getElementById('person-affiliation-add-end');
    const nameEl = document.getElementById('person-affiliation-add-name');
    const affiliation = nameEl.value.trim();
    if (!affiliation) return;
    affiliationDraftRows.push({
      rowId: nextAffiliationRowId(), affiliation,
      startYear: startEl.value ? clampYear(startEl.value) : null,
      endYear: endEl.value ? clampYear(endEl.value) : null,
    });
    startEl.value = ''; endEl.value = ''; nameEl.value = '';
    renderAffiliationList();
  });

  const affiliationList = document.getElementById('person-affiliation-list');
  affiliationList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = affiliationDraftRows.find((a) => a.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pa-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pa-end')) draft.endYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pa-name')) draft.affiliation = e.target.value;
  });
  affiliationList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-affiliation]');
    if (!btn) return;
    affiliationDraftRows = affiliationDraftRows.filter((a) => a.rowId !== btn.dataset.removeAffiliation);
    renderAffiliationList();
  });

  document.getElementById('person-spouse-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('person-spouse-add');
    const name = input.value.trim();
    if (!name) return;
    const pid = await resolvePersonByName(name, editingPersonId);
    input.value = '';
    if (!pid || pid === editingPersonId || spouseDraftIds.includes(pid)) { renderPersonNameDatalist(); return; }
    spouseDraftIds.push(pid);
    renderSpouseList();
    renderPersonNameDatalist();
  });
  document.getElementById('person-spouse-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-spouse]');
    if (!btn) return;
    spouseDraftIds = spouseDraftIds.filter((id) => id !== Number(btn.dataset.removeSpouse));
    renderSpouseList();
  });

  document.getElementById('person-child-add-btn').addEventListener('click', () => addChildRelation('person-child-add', 'bio'));
  document.getElementById('person-adopted-child-add-btn').addEventListener('click', () => addChildRelation('person-adopted-child-add', 'adopted'));
  document.getElementById('person-children-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-child]');
    if (!btn) return;
    removeChildRelation(Number(btn.dataset.removeChild), 'bio');
  });
  document.getElementById('person-adopted-children-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-adopted-child]');
    if (!btn) return;
    removeChildRelation(Number(btn.dataset.removeAdoptedChild), 'adopted');
  });

  document.getElementById('memo-detect-btn').addEventListener('click', detectPeopleInMemo);
  document.getElementById('memo-add-person-btn').addEventListener('click', () => {
    const sel = document.getElementById('memo-add-person');
    const pid = Number(sel.value);
    if (!pid) return;
    memoDetectedPersonIds.add(pid);
    renderMemoDetectedList();
  });
  document.getElementById('memo-detected-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-memo]');
    if (!btn) return;
    memoDetectedPersonIds.delete(Number(btn.dataset.removeMemo));
    renderMemoDetectedList();
  });
  document.getElementById('memo-create-event-btn').addEventListener('click', createEventFromMemo);
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
