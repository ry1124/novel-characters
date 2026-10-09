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
let treeDeleteMode = false;
let personYearFocusId = null;
// 人物・出来事の編集フォームで未保存の変更があるかどうか(離脱時に警告を出すため)
let formDirty = false;
const DIRTY_TRACKED_VIEWS = ['view-edit-person', 'view-edit-event'];

const STATUS_LIST = ['生存', '死亡', '負傷', '不明'];
const STATUS_CLASS = { 生存: 'alive', 死亡: 'dead', 負傷: 'injured', 不明: 'unknown' };

// 討ち取った相手・負傷させた相手は複数人対応(killedPersonIds/injuredPersonIds)。
// 旧バージョン(1人のみ、killedPersonId/injuredPersonId)で保存済みのデータも読めるようにフォールバックする
function killedIdsOf(p) { return p.killedPersonIds || (p.killedPersonId != null ? [p.killedPersonId] : []); }
function injuredIdsOf(p) { return p.injuredPersonIds || (p.injuredPersonId != null ? [p.injuredPersonId] : []); }

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
  // .viewはdisplay:noneで隠すだけで要素は再利用されるため、スクロール位置が残ったままになる。
  // 残っていると、sticky表示のtopbarの下にフィルターや一覧の先頭が隠れて「見えない」ように見えるため、毎回先頭へ戻す
  const el = document.getElementById(viewId);
  if (el) el.scrollTop = 0;
  const renderFn = RENDER_FNS[viewId];
  if (renderFn) renderFn();
}

// 編集フォームに未保存の変更がある状態でそこから離れようとした時だけ確認する
function confirmLeaveDirtyForm() {
  const current = navStack[navStack.length - 1];
  if (!formDirty || !DIRTY_TRACKED_VIEWS.includes(current)) return true;
  return confirm('保存されていない変更があります。このまま離れると変更は破棄されます。よろしいですか?');
}

function navigateTo(viewId) {
  if (!confirmLeaveDirtyForm()) return;
  formDirty = false;
  navStack.push(viewId);
  applyView(viewId);
}

function goBack() {
  if (!confirmLeaveDirtyForm()) return;
  formDirty = false;
  if (navStack.length > 1) navStack.pop();
  applyView(navStack[navStack.length - 1]);
}

function switchTab(viewId) {
  if (!confirmLeaveDirtyForm()) return;
  formDirty = false;
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

// ===== 人物フォーム: 資格(複数・期間あり)編集 ===== (役職・所属と同じ要領)
let qualificationDraftRows = [];
let qualificationRowSeq = 0;
function nextQualificationRowId() { return 'qualification' + (qualificationRowSeq++); }

function renderQualificationList() {
  const listEl = document.getElementById('person-qualification-list');
  listEl.innerHTML = qualificationDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pq-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
      <input class="pq-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
      <input class="pq-name" type="text" value="${escapeHtml(row.qualification || '')}" placeholder="資格名">
      <button type="button" class="remove-btn" data-remove-qualification="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 勲章(複数、授与年のみ)編集 =====
let medalDraftRows = [];
let medalRowSeq = 0;
function nextMedalRowId() { return 'medal' + (medalRowSeq++); }

function renderMedalList() {
  const listEl = document.getElementById('person-medal-list');
  listEl.innerHTML = medalDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pmd-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="授与年">
      <input class="pmd-name" type="text" value="${escapeHtml(row.medal || '')}" placeholder="勲章名">
      <button type="button" class="remove-btn" data-remove-medal="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 能力(複数、名前のみ)編集 =====
let abilityDraftRows = [];
let abilityRowSeq = 0;
function nextAbilityRowId() { return 'ability' + (abilityRowSeq++); }

function renderAbilityList() {
  const listEl = document.getElementById('person-ability-list');
  listEl.innerHTML = abilityDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pab-name" type="text" value="${escapeHtml(row.ability || '')}" placeholder="能力名">
      <button type="button" class="remove-btn" data-remove-ability="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 技(複数、名前のみ)編集 =====
let skillDraftRows = [];
let skillRowSeq = 0;
function nextSkillRowId() { return 'skill' + (skillRowSeq++); }

function renderSkillList() {
  const listEl = document.getElementById('person-skill-list');
  listEl.innerHTML = skillDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="psk-name" type="text" value="${escapeHtml(row.skill || '')}" placeholder="技名">
      <button type="button" class="remove-btn" data-remove-skill="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 人間関係(血縁以外、複数)編集 =====
// 家族(father/mother/spouse)とは別に、師弟・友好・敵対など自由な関係を記録する
let relationshipDraftRows = [];
let relationshipRowSeq = 0;
function nextRelationshipRowId() { return 'relationship' + (relationshipRowSeq++); }

function renderRelationshipList() {
  const listEl = document.getElementById('person-relationship-list');
  listEl.innerHTML = relationshipDraftRows.map((row) => {
    const p = personById(row.personId);
    return `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <div class="list-item-main">${escapeHtml(p ? p.name : '?')}</div>
      <input class="prl-type" type="text" value="${escapeHtml(row.type || '')}" placeholder="関係" list="relationship-type-datalist">
      <button type="button" class="remove-btn" data-remove-relationship="${row.rowId}">×</button>
    </li>`;
  }).join('');
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
  // 他の人物が既に使っている所属名を候補に出す(新しい表記ゆれを防ぐ)
  const affiliationNames = new Set();
  people.forEach((p) => (p.affiliations || []).forEach((a) => { if (a.affiliation) affiliationNames.add(a.affiliation); }));
  document.getElementById('affiliation-datalist').innerHTML =
    Array.from(affiliationNames).map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  const roleNames = new Set();
  people.forEach((p) => (p.roles || []).forEach((r) => { if (r.role) roleNames.add(r.role); }));
  document.getElementById('role-datalist').innerHTML =
    Array.from(roleNames).map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  populatePersonFormSelects();
}

// ===== 人物フォーム: 既存の人物をプルダウンから選べるようにする共通処理 =====
// (datalistはiOS Safariでの対応が不安定で、見えない/選べないことがあるため使わない)
const NEW_PERSON_OPTION = '__new__';
function personSelectOptionsHtml(selectedId, excludeIds, placeholder) {
  const exclude = new Set((excludeIds || []).filter((id) => id != null));
  const sorted = people.filter((p) => !exclude.has(p.id)).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  const opts = [`<option value="">${escapeHtml(placeholder)}</option>`, `<option value="${NEW_PERSON_OPTION}">+ 新しい人物を作成...</option>`];
  sorted.forEach((p) => {
    opts.push(`<option value="${p.id}" ${String(p.id) === String(selectedId ?? '') ? 'selected' : ''}>${escapeHtml(p.name)}</option>`);
  });
  return opts.join('');
}

// 現在選択中の値は保持したまま、全ての人物選択プルダウンの選択肢を最新のpeopleで作り直す。
// overridesで渡したものだけ選択値を明示的に変更する(新規作成直後など)
function populatePersonFormSelects(overrides) {
  overrides = overrides || {};
  const excludeSelf = editingPersonId != null ? [editingPersonId] : [];
  const fatherEl = document.getElementById('person-form-father');
  const motherEl = document.getElementById('person-form-mother');
  const curFather = 'father' in overrides ? overrides.father : fatherEl.value;
  const curMother = 'mother' in overrides ? overrides.mother : motherEl.value;
  fatherEl.innerHTML = personSelectOptionsHtml(curFather, excludeSelf, '(未設定)');
  motherEl.innerHTML = personSelectOptionsHtml(curMother, excludeSelf, '(未設定)');
  document.getElementById('person-spouse-add').innerHTML =
    personSelectOptionsHtml('', [...excludeSelf, ...spouseDraftIds], '選択してください');
  document.getElementById('person-child-add').innerHTML = personSelectOptionsHtml('', excludeSelf, '選択してください');
  document.getElementById('person-adopted-child-add').innerHTML = personSelectOptionsHtml('', excludeSelf, '選択してください');
  document.getElementById('person-relationship-add-person').innerHTML = personSelectOptionsHtml('', excludeSelf, '選択してください');
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

// 人物選択プルダウンの選択値から人物IDを取り出す。「+ 新しい人物を作成...」ならその場で名前を聞いて作成する
async function resolvePersonFromSelect(selectEl, promptLabel) {
  const val = selectEl.value;
  if (!val) return null;
  if (val === NEW_PERSON_OPTION) {
    const name = (prompt(`${promptLabel}の名前を入力してください`) || '').trim();
    if (!name) return null;
    return await resolvePersonByName(name, editingPersonId);
  }
  return Number(val);
}

// kind: 'bio' | 'adopted'。子となる人物の父/母(または養父/養母)の欄に、この編集中の人物を設定する
async function addChildRelation(selectId, kind) {
  if (!editingPersonId) return;
  const select = document.getElementById(selectId);
  const childId = await resolvePersonFromSelect(select, kind === 'bio' ? '子' : '養子');
  if (childId == null || childId === editingPersonId) { populatePersonFormSelects(); return; } // 自分自身を子にはできない
  const focus = personById(editingPersonId);
  const asFather = confirm(`${focus.name}を新しい子の「父」として登録しますか?\n(OK=父として登録／キャンセル=母として登録)`);
  const child = await DB.getPerson(childId);
  if (kind === 'bio') {
    if (asFather) child.fatherId = editingPersonId; else child.motherId = editingPersonId;
  } else {
    if (asFather) child.adoptiveFatherId = editingPersonId; else child.adoptiveMotherId = editingPersonId;
  }
  await DB.updatePerson(child);
  if (kind === 'bio') await autoLinkParentsAsSpouses(child.fatherId, child.motherId);
  await refreshAll();
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
  formDirty = false;
  editingPersonId = id;
  const nameEl = document.getElementById('person-form-name');
  const kanaEl = document.getElementById('person-form-kana');
  const youmeiEl = document.getElementById('person-form-youmei');
  const maidenNameEl = document.getElementById('person-form-maiden-name');
  const genpukuYearEl = document.getElementById('person-form-genpuku-year');
  const genpukuMonthEl = document.getElementById('person-form-genpuku-month');
  const birthEl = document.getElementById('person-form-birth');
  const deathEl = document.getElementById('person-form-death');
  let initialFatherId = '';
  let initialMotherId = '';
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
    qualificationDraftRows = (p.qualifications || []).map((q) => ({ rowId: nextQualificationRowId(), qualification: q.qualification, startYear: q.startYear, endYear: q.endYear }));
    medalDraftRows = (p.medals || []).map((m) => ({ rowId: nextMedalRowId(), medal: m.medal, startYear: m.startYear }));
    abilityDraftRows = (p.abilities || []).map((a) => ({ rowId: nextAbilityRowId(), ability: a.ability }));
    skillDraftRows = (p.skills || []).map((s) => ({ rowId: nextSkillRowId(), skill: s.skill }));
    relationshipDraftRows = (p.relationships || []).map((r) => ({ rowId: nextRelationshipRowId(), personId: r.personId, type: r.type }));
    initialFatherId = p.fatherId != null ? String(p.fatherId) : '';
    initialMotherId = p.motherId != null ? String(p.motherId) : '';
    spouseDraftIds = (p.spouseIds || []).slice();
  } else {
    nameEl.value = ''; kanaEl.value = ''; youmeiEl.value = ''; maidenNameEl.value = '';
    genpukuYearEl.value = ''; genpukuMonthEl.value = ''; birthEl.value = ''; deathEl.value = '';
    summaryDraftRows = [];
    roleDraftRows = [];
    affiliationDraftRows = [];
    qualificationDraftRows = [];
    medalDraftRows = [];
    abilityDraftRows = [];
    skillDraftRows = [];
    relationshipDraftRows = [];
    initialFatherId = '';
    initialMotherId = '';
    spouseDraftIds = [];
  }
  renderPersonNameDatalist();
  populatePersonFormSelects({ father: initialFatherId, mother: initialMotherId });
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
  document.getElementById('person-qualification-add-start').value = '';
  document.getElementById('person-qualification-add-end').value = '';
  document.getElementById('person-qualification-add-name').value = '';
  document.getElementById('person-medal-add-start').value = '';
  document.getElementById('person-medal-add-name').value = '';
  renderSummaryList();
  renderRoleList();
  renderAffiliationList();
  renderQualificationList();
  renderMedalList();
  renderAbilityList();
  renderSkillList();
  renderRelationshipList();
  renderSpouseList();
  renderChildrenSection();
  navigateTo('view-edit-person');
}

function openEventForm(id, parentId) {
  formDirty = false;
  editingEventId = id;
  const titleEl = document.getElementById('event-form-title');
  const categoryEl = document.getElementById('event-form-category');
  const yearEl = document.getElementById('event-form-year');
  const monthEl = document.getElementById('event-form-month');
  const endYearEl = document.getElementById('event-form-end-year');
  const endMonthEl = document.getElementById('event-form-end-month');
  const descEl = document.getElementById('event-form-description');
  if (id) {
    const ev = eventById(id);
    titleEl.value = ev.title || '';
    categoryEl.value = ev.category || '出来事';
    yearEl.value = ev.year ?? '';
    monthEl.value = ev.month ?? '';
    endYearEl.value = ev.endYear ?? '';
    endMonthEl.value = ev.endMonth ?? '';
    descEl.value = ev.description || '';
    draftParticipants = (ev.participants || []).map((p) => ({ ...p }));
    eventFormParentId = ev.parentEventId ?? null;
  } else {
    titleEl.value = ''; categoryEl.value = '出来事'; yearEl.value = ''; monthEl.value = '';
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
    || (p.affiliations || []).some((a) => (a.affiliation || '').toLowerCase().includes(q))
    || (p.abilities || []).some((a) => (a.ability || '').toLowerCase().includes(q))
    || (p.skills || []).some((s) => (s.skill || '').toLowerCase().includes(q)));
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
  document.getElementById('person-name').textContent = p.name + (p.birthYear != null ? `(${p.birthYear}年〜)` : '');
  document.getElementById('person-kana').textContent = p.kana || '';
  document.getElementById('person-youmei').textContent = p.youmei ? `幼名: ${p.youmei}` : '';
  document.getElementById('person-maiden-name').textContent = p.maidenName ? `旧姓: ${p.maidenName}` : '';
  document.getElementById('person-genpuku').textContent = p.genpukuYear != null ? `元服: ${formatYearMonth(p.genpukuYear, p.genpukuMonth)}` : '';
  const rolesSorted = (p.roles || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  document.getElementById('person-roles-timeline').innerHTML = rolesSorted.map((r) => `<li class="timeline-item">
      <div class="timeline-year">${formatRolePeriod(r)}</div>
      <div class="timeline-body"><div class="timeline-title">${escapeHtml(r.role)}</div></div>
    </li>`).join('');
  document.getElementById('person-relationships').innerHTML = (p.relationships || []).map((r) => {
    const rp = personById(r.personId);
    return `<span class="chip-link" data-person-id="${r.personId}">${escapeHtml(r.type)}: ${escapeHtml(rp ? rp.name : '?')}</span>`;
  }).join('');
  document.getElementById('person-affiliations').textContent = (p.affiliations || []).map((a) => `${a.affiliation}(${formatRolePeriod(a)})`).join('、');
  document.getElementById('person-qualifications').textContent = (p.qualifications || []).map((q) => `${q.qualification}(${formatRolePeriod(q)})`).join('、');
  document.getElementById('person-medals').textContent = (p.medals || []).map((m) => `${m.medal}${m.startYear != null ? `(${m.startYear}年)` : ''}`).join('、');
  document.getElementById('person-abilities').textContent = (p.abilities || []).length ? `能力: ${(p.abilities || []).map((a) => a.ability).join('、')}` : '';
  document.getElementById('person-skills').textContent = (p.skills || []).length ? `技: ${(p.skills || []).map((s) => s.skill).join('、')}` : '';
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
  const category = ev.category || '出来事';
  return `<li class="list-item ${indent ? 'list-item-indent' : ''}" data-event-id="${ev.id}">
    <div class="list-item-main">
      <div class="list-item-title">${indent ? '↳ ' : ''}${escapeHtml(ev.title)} <span class="badge">${escapeHtml(category)}</span></div>
      <div class="list-item-sub">${formatEventTime(ev)} ・ 参加者${(ev.participants || []).length}人</div>
    </div>
    <span class="list-item-chevron">›</span>
  </li>`;
}

let eventsCategoryFilter = '';
function renderEvents() {
  const listEl = document.getElementById('events-list');
  const emptyEl = document.getElementById('events-empty');
  if (!events.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = 'まだ出来事が登録されていません'; return; }
  const q = (document.getElementById('events-search-input').value || '').trim().toLowerCase();
  const topEvents = events.filter((ev) => ev.parentEventId == null
    && (!eventsCategoryFilter || (ev.category || '出来事') === eventsCategoryFilter));
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
  document.getElementById('event-year').textContent = `${ev.category || '出来事'} ・ ${formatEventTime(ev)}`;
  document.getElementById('event-description').textContent = ev.description || '';

  const pm = peopleMapCache();
  const listEl = document.getElementById('event-participants');
  listEl.innerHTML = (ev.participants || []).map((p) => {
    const person = pm.get(p.personId);
    const age = person ? personAgeAt(person, ev.year) : null;
    const killedNames = killedIdsOf(p).map((id) => pm.get(id)).filter(Boolean).map((o) => o.name);
    const injuredNames = injuredIdsOf(p).map((id) => pm.get(id)).filter(Boolean).map((o) => o.name);
    const subParts = [age !== null ? `${age}歳` : '', killedNames.length ? `${killedNames.join('・')}を討ち取った` : '', injuredNames.length ? `${injuredNames.join('・')}を負傷させた` : '', p.note || ''].filter(Boolean);
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

// ===== 役職一覧(人物を横断して、役職名ごとにグループ表示) =====
function renderRoles() {
  const q = (document.getElementById('roles-search-input').value || '').trim().toLowerCase();
  const groups = new Map();
  people.forEach((p) => (p.roles || []).forEach((r) => {
    if (!r.role) return;
    if (!groups.has(r.role)) groups.set(r.role, []);
    groups.get(r.role).push({ person: p, startYear: r.startYear, endYear: r.endYear });
  }));
  const hadAny = groups.size > 0;
  let names = [...groups.keys()];
  if (q) names = names.filter((n) => n.toLowerCase().includes(q));
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  const emptyEl = document.getElementById('roles-empty');
  const listEl = document.getElementById('roles-list');
  if (!names.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = hadAny ? '該当する役職が見つかりません' : 'まだ役職が登録されていません';
    return;
  }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = names.map((name) => {
    const rows = groups.get(name).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
    const rowsHtml = rows.map((row) => `<li class="list-item list-item-indent" data-person-id="${row.person.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(row.person.name)}</div>
          <div class="list-item-sub">${formatRolePeriod(row)}</div>
        </div>
        <span class="list-item-chevron">›</span>
      </li>`).join('');
    return `<li class="list-group-header">${escapeHtml(name)}(${rows.length}人)</li>${rowsHtml}`;
  }).join('');
}

// ===== 役職の一括追加: 1つの役職を、複数人物にまとめて付与する =====
let bulkRoleCheckedIds = new Set();
function openBulkRoleForm() {
  document.getElementById('bulk-role-name').value = '';
  document.getElementById('bulk-role-start').value = '';
  document.getElementById('bulk-role-end').value = '';
  document.getElementById('bulk-role-person-search').value = '';
  bulkRoleCheckedIds = new Set();
  renderBulkRolePersonList();
}
function renderBulkRolePersonList() {
  const q = (document.getElementById('bulk-role-person-search').value || '').trim().toLowerCase();
  const listEl = document.getElementById('bulk-role-person-list');
  const filtered = q ? people.filter((p) => (p.name || '').toLowerCase().includes(q)) : people;
  const sorted = filtered.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  listEl.innerHTML = sorted.map((p) => `<li class="list-item list-item-check" data-person-id="${p.id}">
      <input type="checkbox" class="bulk-role-check" data-person-id="${p.id}" ${bulkRoleCheckedIds.has(p.id) ? 'checked' : ''}>
      <div class="list-item-main"><div class="list-item-title">${escapeHtml(p.name)}</div></div>
    </li>`).join('');
}

// ===== 組織一覧(人物を横断して、所属名ごとにグループ表示) =====
function renderOrganizations() {
  const q = (document.getElementById('organizations-search-input').value || '').trim().toLowerCase();
  const groups = new Map();
  people.forEach((p) => (p.affiliations || []).forEach((a) => {
    if (!a.affiliation) return;
    if (!groups.has(a.affiliation)) groups.set(a.affiliation, []);
    groups.get(a.affiliation).push({ person: p, startYear: a.startYear, endYear: a.endYear });
  }));
  const hadAny = groups.size > 0;
  let names = [...groups.keys()];
  if (q) names = names.filter((n) => n.toLowerCase().includes(q));
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  const emptyEl = document.getElementById('organizations-empty');
  const listEl = document.getElementById('organizations-list');
  if (!names.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = hadAny ? '該当する組織が見つかりません' : 'まだ所属が登録されていません';
    return;
  }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = names.map((name) => {
    const rows = groups.get(name).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
    const rowsHtml = rows.map((row) => `<li class="list-item list-item-indent" data-person-id="${row.person.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(row.person.name)}</div>
          <div class="list-item-sub">${formatRolePeriod(row)}</div>
        </div>
        <span class="list-item-chevron">›</span>
      </li>`).join('');
    return `<li class="list-group-header">${escapeHtml(name)}(${rows.length}人)</li>${rowsHtml}`;
  }).join('');
}

// ===== 組織の一括追加: 1つの組織を、複数人物にまとめて付与する =====
let bulkAffiliationCheckedIds = new Set();
function openBulkAffiliationForm() {
  document.getElementById('bulk-affiliation-name').value = '';
  document.getElementById('bulk-affiliation-start').value = '';
  document.getElementById('bulk-affiliation-end').value = '';
  document.getElementById('bulk-affiliation-person-search').value = '';
  bulkAffiliationCheckedIds = new Set();
  renderBulkAffiliationPersonList();
}
function renderBulkAffiliationPersonList() {
  const q = (document.getElementById('bulk-affiliation-person-search').value || '').trim().toLowerCase();
  const listEl = document.getElementById('bulk-affiliation-person-list');
  const filtered = q ? people.filter((p) => (p.name || '').toLowerCase().includes(q)) : people;
  const sorted = filtered.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  listEl.innerHTML = sorted.map((p) => `<li class="list-item list-item-check" data-person-id="${p.id}">
      <input type="checkbox" class="bulk-affiliation-check" data-person-id="${p.id}" ${bulkAffiliationCheckedIds.has(p.id) ? 'checked' : ''}>
      <div class="list-item-main"><div class="list-item-title">${escapeHtml(p.name)}</div></div>
    </li>`).join('');
}

// ===== 出来事フォーム: 参加者編集 =====
function renderEventFormParticipants() {
  const pm = peopleMapCache();
  const listEl = document.getElementById('event-form-participants');
  listEl.innerHTML = draftParticipants.map((p) => {
    const person = pm.get(p.personId);
    const options = STATUS_LIST.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`).join('');
    const killedIds = killedIdsOf(p);
    const injuredIds = injuredIdsOf(p);
    // 選択肢には「本人」と「既に追加済みの相手」を出さない(同じ相手を二重追加できないようにするため)
    const otherOptionsFor = (excludeIds, placeholder) => [`<option value="">${placeholder}</option>`]
      .concat(draftParticipants.filter((o) => o.personId !== p.personId && !excludeIds.includes(o.personId)).map((o) => {
        const op = pm.get(o.personId);
        return `<option value="${o.personId}">${escapeHtml(op ? op.name : '?')}</option>`;
      })).join('');
    const killOptions = otherOptionsFor(killedIds, '討ち取った相手を選ぶ-');
    const injureOptions = otherOptionsFor(injuredIds, '負傷させた相手を選ぶ-');
    const chipsOf = (ids, removeAttr) => ids.map((id) => {
      const op = pm.get(id);
      return `<span class="chip-link" ${removeAttr}="${id}">${escapeHtml(op ? op.name : '?')} ×</span>`;
    }).join('');
    return `<li class="participant-row-wrap" data-pid="${p.personId}">
      <div class="participant-row-top">
        <div class="list-item-main">${escapeHtml(person ? person.name : '(不明)')}</div>
        <select class="pf-status">${options}</select>
        <button type="button" class="remove-btn" data-remove="${p.personId}">×</button>
      </div>
      <div class="participant-row-bottom">
        <select class="pf-kill">${killOptions}</select>
        <button type="button" class="add-btn pf-kill-add">＋</button>
      </div>
      ${killedIds.length ? `<div class="chip-wrap">${chipsOf(killedIds, 'data-kill-remove')}</div>` : ''}
      <div class="participant-row-bottom">
        <select class="pf-injure">${injureOptions}</select>
        <button type="button" class="add-btn pf-injure-add">＋</button>
      </div>
      ${injuredIds.length ? `<div class="chip-wrap">${chipsOf(injuredIds, 'data-injure-remove')}</div>` : ''}
      <div class="participant-row-bottom">
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
      terrainMap: null, participants: [{ personId, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [] }],
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
  const qualifications = qualificationDraftRows
    .filter((q) => (q.qualification || '').trim())
    .map((q) => ({
      qualification: q.qualification.trim(),
      startYear: q.startYear != null && q.startYear !== '' ? clampYear(q.startYear) : null,
      endYear: q.endYear != null && q.endYear !== '' ? clampYear(q.endYear) : null,
    }));
  const medals = medalDraftRows
    .filter((m) => (m.medal || '').trim())
    .map((m) => ({
      medal: m.medal.trim(),
      startYear: m.startYear != null && m.startYear !== '' ? clampYear(m.startYear) : null,
    }));
  const abilities = abilityDraftRows
    .filter((a) => (a.ability || '').trim())
    .map((a) => ({ ability: a.ability.trim() }));
  const skills = skillDraftRows
    .filter((s) => (s.skill || '').trim())
    .map((s) => ({ skill: s.skill.trim() }));
  const relationships = relationshipDraftRows
    .filter((r) => r.personId != null && (r.type || '').trim())
    .map((r) => ({ personId: r.personId, type: r.type.trim() }));
  const fatherVal = document.getElementById('person-form-father').value;
  const motherVal = document.getElementById('person-form-mother').value;
  const fatherId = fatherVal ? Number(fatherVal) : null;
  const motherId = motherVal ? Number(motherVal) : null;
  const spouseIds = spouseDraftIds.slice();
  let personId = editingPersonId;
  let oldSpouseIds = [];
  if (editingPersonId) {
    const p = personById(editingPersonId);
    oldSpouseIds = p.spouseIds || [];
    p.name = name; p.kana = kana; p.youmei = youmei; p.maidenName = maidenName; p.genpukuYear = genpukuYear; p.genpukuMonth = genpukuMonth;
    p.roles = roles; p.affiliations = affiliations; p.qualifications = qualifications; p.medals = medals;
    p.abilities = abilities; p.skills = skills; p.relationships = relationships;
    p.birthYear = birthYear; p.deathYear = deathYear;
    p.fatherId = fatherId; p.motherId = motherId; p.spouseIds = spouseIds;
    await DB.updatePerson(p);
  } else {
    personId = await DB.addPerson({
      name, kana, youmei, maidenName, genpukuYear, genpukuMonth, roles, affiliations, qualifications, medals,
      abilities, skills, relationships, birthYear, deathYear, fatherId, motherId, spouseIds, createdAt: Date.now(),
    });
    currentPersonId = personId;
  }
  await syncSpouseLinks(personId, oldSpouseIds, spouseIds);
  await autoLinkParentsAsSpouses(fatherId, motherId);
  await syncSummaryRows(personId);
  await refreshAll();
  formDirty = false;
  goBack();
}

// 子の父・母が両方わかった時点で、その2人を自動的に配偶者として結びつける(明示的な配偶者登録を省略できるようにする)
async function autoLinkParentsAsSpouses(fatherId, motherId) {
  if (fatherId == null || motherId == null) return;
  const father = people.find((p) => p.id === fatherId);
  const mother = people.find((p) => p.id === motherId);
  if (!father || !mother) return;
  if (!(father.spouseIds || []).includes(motherId)) {
    father.spouseIds = [...(father.spouseIds || []), motherId];
    await DB.updatePerson(father);
  }
  if (!(mother.spouseIds || []).includes(fatherId)) {
    mother.spouseIds = [...(mother.spouseIds || []), fatherId];
    await DB.updatePerson(mother);
  }
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
    if ((other.relationships || []).some((r) => r.personId === id)) {
      other.relationships = other.relationships.filter((r) => r.personId !== id);
      changed = true;
    }
    if (changed) await DB.updatePerson(other);
  }
  await DB.deletePerson(id);
  await refreshAll();
  navStack = navStack.filter((v) => v !== 'view-person-detail');
  goBack();
}

// 出来事内で「死亡」になった参加者の没年を、人物側に自動反映する(既に没年が入っている人物は上書きしない)
async function syncDeathYearsFromParticipants(ev) {
  for (const part of ev.participants || []) {
    if (part.status !== '死亡') continue;
    const person = personById(part.personId);
    if (person && person.deathYear == null) {
      person.deathYear = ev.year;
      await DB.updatePerson(person);
    }
  }
}

async function saveEventForm() {
  const title = document.getElementById('event-form-title').value.trim();
  if (!title) { alert('出来事を入力してください'); return; }
  const category = document.getElementById('event-form-category').value || '出来事';
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
    ev.title = title; ev.category = category; ev.year = year; ev.month = month; ev.endYear = endYear; ev.endMonth = endMonth;
    ev.description = description; ev.participants = draftParticipants;
    await DB.updateEvent(ev);
    currentEventId = ev.id;
    await syncDeathYearsFromParticipants(ev);
  } else {
    const id = await DB.addEvent({ title, category, year, month, endYear, endMonth, description, terrainMap: null, participants: draftParticipants, parentEventId: eventFormParentId });
    currentEventId = id;
    await syncDeathYearsFromParticipants({ year, participants: draftParticipants });
  }
  await refreshAll();
  formDirty = false;
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
  draftParticipants = Array.from(memoDetectedPersonIds).map((pid) => ({ personId: pid, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [] }));
  renderEventFormParticipants();
  renderAddPersonSelect();
  navigateTo('view-edit-event');
}

// ===== 家系図 =====
function openFamilyTree(id) {
  familyTreeFocusId = id;
  renderFamilyTree();
}

// 樹形図のボックス配置: 1行分の人物をcenterX基準で横に並べた座標を返す(centerX省略時は0)
const TREE_BOX_W = 92, TREE_BOX_H = 44, TREE_GAP = 14;
function treeRowLayout(items, y, centerX) {
  const cx0 = centerX || 0;
  const n = items.length;
  const totalW = n * TREE_BOX_W + Math.max(0, n - 1) * TREE_GAP;
  const startX = cx0 - totalW / 2;
  return items.map((person, i) => {
    const x = startX + i * (TREE_BOX_W + TREE_GAP);
    return { person, x, y, cx: x + TREE_BOX_W / 2, cy: y + TREE_BOX_H / 2 };
  });
}

function renderFamilyTree() {
  const p = personById(familyTreeFocusId);
  if (!p) { goBack(); return; }

  // 実親・養親は両方いる場合は両方表示する(片方しかいない場合はその片方だけ出す)
  const father = p.fatherId != null ? personById(p.fatherId) : null;
  const mother = p.motherId != null ? personById(p.motherId) : null;
  const adoptiveFather = p.adoptiveFatherId != null ? personById(p.adoptiveFatherId) : null;
  const adoptiveMother = p.adoptiveMotherId != null ? personById(p.adoptiveMotherId) : null;
  const parentEntries = [
    father ? { person: father, label: '父', rel: 'father' } : null,
    adoptiveFather ? { person: adoptiveFather, label: '養父', rel: 'adoptiveFather' } : null,
    mother ? { person: mother, label: '母', rel: 'mother' } : null,
    adoptiveMother ? { person: adoptiveMother, label: '養母', rel: 'adoptiveMother' } : null,
  ].filter(Boolean);

  // 祖父母: 表示中の父母(実親・養親含む)それぞれの実の父・母をさらに1世代さかのぼって表示する
  const sideLabel = { father: '父方', mother: '母方', adoptiveFather: '養父方', adoptiveMother: '養母方' };
  const grandparentGroups = parentEntries.map((entry) => {
    const gf = entry.person.fatherId != null ? personById(entry.person.fatherId) : null;
    const gm = entry.person.motherId != null ? personById(entry.person.motherId) : null;
    const items = [
      gf ? { person: gf, label: `${sideLabel[entry.rel]}の祖父` } : null,
      gm ? { person: gm, label: `${sideLabel[entry.rel]}の祖母` } : null,
    ].filter(Boolean);
    return { entry, items };
  });

  // 兄弟姉妹は、実親・養親のいずれかを1人でも共有していれば検出する(全血/異母/異父/養子同士も含む)
  const parentIdsOf = (x) => [x.fatherId, x.motherId, x.adoptiveFatherId, x.adoptiveMotherId].filter((id) => id != null);
  const pParentIds = new Set(parentIdsOf(p));
  const siblings = people.filter((c) => c.id !== p.id && parentIdsOf(c).some((id) => pParentIds.has(id)));
  // 本人も兄弟姉妹と同じ基準(誕生年、年長が左)で並べる。生年未登録は年少側(右)扱い
  const selfRowPeople = [...siblings, p].sort((a, b) => (a.birthYear ?? 1e9) - (b.birthYear ?? 1e9));
  const spouses = (p.spouseIds || []).map((sid) => personById(sid)).filter(Boolean);
  const bioChildren = people.filter((c) => c.fatherId === p.id || c.motherId === p.id);
  const adoptedChildren = people.filter((c) => c.adoptiveFatherId === p.id || c.adoptiveMotherId === p.id);
  const childrenRowPeople = bioChildren.concat(adoptedChildren);

  const rowY = { grandparents: 36, parents: 190, mid: 344, children: 498 };
  const parentsPos = treeRowLayout(parentEntries.map((e) => e.person), rowY.parents);
  // 祖父母は該当する親(父/養父/母/養母)の真上に、そのグループだけで中央寄せして配置する
  const grandparentsPosGroups = grandparentGroups.map((g, i) => treeRowLayout(g.items.map((it) => it.person), rowY.grandparents, parentsPos[i] ? parentsPos[i].cx : 0));
  const grandparentsPos = grandparentsPosGroups.flat();
  // 本人・兄弟姉妹は生年順の並びをそのまま中央寄せし、配偶者は本人の右隣に挿入する
  // (本人より年下の兄弟姉妹がいる場合は、挿入した配偶者の分だけ右へずらして重なりを避ける)
  const selfRowPosRaw = treeRowLayout(selfRowPeople, rowY.mid);
  const selfIdxRaw = selfRowPeople.findIndex((s) => s.id === p.id);
  const spouseShift = spouses.length * (TREE_BOX_W + TREE_GAP);
  const selfRowPos = selfRowPosRaw.map((pos, i) => (i > selfIdxRaw && spouseShift)
    ? { ...pos, x: pos.x + spouseShift, cx: pos.cx + spouseShift } : pos);
  const selfPos = selfRowPos[selfIdxRaw];
  const spousePos = spouses.map((sp, i) => {
    const x = selfPos.x + (i + 1) * (TREE_BOX_W + TREE_GAP);
    return { person: sp, x, y: rowY.mid, cx: x + TREE_BOX_W / 2, cy: rowY.mid + TREE_BOX_H / 2 };
  });
  const midPos = selfRowPos.concat(spousePos);
  // 子の行は本人(+配偶者)の実際の位置の真下に中央寄せする(全体の中心0に合わせると親の位置によってズレるため)
  const coupleCenterX = spousePos.length ? (selfPos.cx + spousePos[spousePos.length - 1].cx) / 2 : selfPos.cx;
  const childrenPos = treeRowLayout(childrenRowPeople, rowY.children, coupleCenterX);

  const allX = [...grandparentsPos, ...parentsPos, ...midPos, ...childrenPos].map((b) => b.x);
  const minX = allX.length ? Math.min(...allX) : -TREE_BOX_W / 2;
  const maxX = allX.length ? Math.max(...allX) + TREE_BOX_W : TREE_BOX_W / 2;
  const width = Math.max(maxX - minX + 80, 320);
  const offsetX = -minX + 40;
  const shift = (boxes) => boxes.map((b) => ({ ...b, x: b.x + offsetX, cx: b.cx + offsetX }));
  const grandparentsBoxes = shift(grandparentsPos);
  const parentsBoxes = shift(parentsPos);
  const midBoxes = shift(midPos);
  const childrenBoxes = shift(childrenPos);
  // 祖父母はグループ(父方・母方など)ごとに連結線を引くため、シフト後の座標をグループ単位に戻す
  let gpOffset = 0;
  const grandparentsBoxGroups = grandparentGroups.map((g) => {
    const boxes = grandparentsBoxes.slice(gpOffset, gpOffset + g.items.length);
    gpOffset += g.items.length;
    return { entry: g.entry, items: g.items, boxes };
  });

  const TREE_VIEW_H = 580;
  const TREE_DISPLAY_RATIO = 0.8;
  const svg = document.getElementById('family-tree-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${TREE_VIEW_H}`);
  // 表示領域の高さは固定、幅は人数が増えても縮めずviewBoxと同じ比率で伸ばし、はみ出た分は横スクロールで見る
  svg.style.height = (TREE_VIEW_H * TREE_DISPLAY_RATIO) + 'px';
  svg.style.width = (width * TREE_DISPLAY_RATIO) + 'px';
  svg.innerHTML = '';
  const LINE = '#b9b0d6';
  // 養子関係は実線2本("＝"風の二重線)、血縁は実線1本で見分けられるようにする
  const drawConnector = (x1, y1, x2, y2, isAdoptive) => {
    if (isAdoptive) {
      svg.appendChild(svgEl('line', { x1: x1 - 1.5, y1, x2: x2 - 1.5, y2, stroke: LINE, 'stroke-width': 1.5 }));
      svg.appendChild(svgEl('line', { x1: x1 + 1.5, y1, x2: x2 + 1.5, y2, stroke: LINE, 'stroke-width': 1.5 }));
    } else {
      svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: LINE, 'stroke-width': 2 }));
    }
  };

  // 祖父母 → 該当する親への接続(本人-配偶者と同じ点線の婚姻線+組の中心から1本の線)
  grandparentsBoxGroups.forEach((grp) => {
    if (!grp.boxes.length) return;
    const parentBox = parentsBoxes.find((b, i) => parentEntries[i].rel === grp.entry.rel);
    if (!parentBox) return;
    const gpBottomY = rowY.grandparents + TREE_BOX_H;
    const gpCy = rowY.grandparents + TREE_BOX_H / 2;
    let trunkX;
    if (grp.boxes.length === 2) {
      const [a, b] = grp.boxes;
      svg.appendChild(svgEl('line', { x1: a.cx, y1: gpCy, x2: b.cx, y2: gpCy, stroke: '#5b37b7', 'stroke-width': 2, 'stroke-dasharray': '4,3' }));
      trunkX = (a.cx + b.cx) / 2;
    } else {
      trunkX = grp.boxes[0].cx;
    }
    svg.appendChild(svgEl('line', { x1: trunkX, y1: gpBottomY, x2: parentBox.cx, y2: rowY.parents, stroke: LINE, 'stroke-width': 2 }));
  });

  const selfPeopleBoxes = midBoxes.slice(0, selfRowPeople.length);
  if (parentsBoxes.length && selfPeopleBoxes.length) {
    const parentBottomY = rowY.parents + TREE_BOX_H;
    const parentCy = rowY.parents + TREE_BOX_H / 2;
    const busY = (parentBottomY + rowY.mid) / 2;
    const boxByRel = (rel) => { const idx = parentEntries.findIndex((e) => e.rel === rel); return idx >= 0 ? parentsBoxes[idx] : null; };
    const pairedRels = new Set();
    const trunkXs = [];
    // 父と母(実親・養親それぞれの組)は、本人と配偶者を結ぶのと同じ点線で婚姻を表し、組の中心から1本だけ子の世代へ線を落とす
    [['father', 'mother'], ['adoptiveFather', 'adoptiveMother']].forEach(([relA, relB]) => {
      const a = boxByRel(relA), b = boxByRel(relB);
      if (!a || !b) return;
      pairedRels.add(relA); pairedRels.add(relB);
      svg.appendChild(svgEl('line', { x1: a.cx, y1: parentCy, x2: b.cx, y2: parentCy, stroke: '#5b37b7', 'stroke-width': 2, 'stroke-dasharray': '4,3' }));
      const midX = (a.cx + b.cx) / 2;
      svg.appendChild(svgEl('line', { x1: midX, y1: parentBottomY, x2: midX, y2: busY, stroke: LINE, 'stroke-width': 2 }));
      trunkXs.push(midX);
    });
    // 配偶者が一緒にいない単独の親(片親のみ登録、など)は、そのまま1本の線を子の世代へ落とす
    parentsBoxes.forEach((b, i) => {
      const rel = parentEntries[i].rel;
      if (pairedRels.has(rel)) return;
      const isAdoptive = rel === 'adoptiveFather' || rel === 'adoptiveMother';
      drawConnector(b.cx, parentBottomY, b.cx, busY, isAdoptive);
      trunkXs.push(b.cx);
    });
    const selfXs = selfPeopleBoxes.map((b) => b.cx);
    const left = Math.min(...trunkXs, ...selfXs), right = Math.max(...trunkXs, ...selfXs);
    svg.appendChild(svgEl('line', { x1: left, y1: busY, x2: right, y2: busY, stroke: LINE, 'stroke-width': 2 }));
    selfPeopleBoxes.forEach((b) => svg.appendChild(svgEl('line', { x1: b.cx, y1: busY, x2: b.cx, y2: rowY.mid, stroke: LINE, 'stroke-width': 2 })));
  }

  const selfIdx = selfRowPeople.findIndex((s) => s.id === p.id);
  const selfBox = midBoxes[selfIdx];
  const spouseBoxes = midBoxes.slice(selfRowPeople.length);
  spouseBoxes.forEach((sb) => {
    svg.appendChild(svgEl('line', { x1: selfBox.cx, y1: selfBox.cy, x2: sb.cx, y2: sb.cy, stroke: '#5b37b7', 'stroke-width': 2, 'stroke-dasharray': '4,3' }));
  });

  if (childrenBoxes.length) {
    const childParentCx = spouseBoxes.length ? (selfBox.cx + spouseBoxes[0].cx) / 2 : selfBox.cx;
    const parentBottomY2 = rowY.mid + TREE_BOX_H;
    const busY2 = (parentBottomY2 + rowY.children) / 2;
    svg.appendChild(svgEl('line', { x1: childParentCx, y1: parentBottomY2, x2: childParentCx, y2: busY2, stroke: LINE, 'stroke-width': 2 }));
    const left = childrenBoxes[0].cx, right = childrenBoxes[childrenBoxes.length - 1].cx;
    svg.appendChild(svgEl('line', { x1: left, y1: busY2, x2: right, y2: busY2, stroke: LINE, 'stroke-width': 2 }));
    childrenBoxes.forEach((b) => {
      const isAdopted = adoptedChildren.some((c) => c.id === b.person.id);
      drawConnector(b.cx, busY2, b.cx, rowY.children, isAdopted);
    });
  }

  const drawBox = (b, isSelf, subLabel, relation) => {
    const g = svgEl('g', { 'data-tree-person': b.person.id, 'data-tree-relation': relation, style: 'cursor:pointer' });
    g.appendChild(svgEl('rect', {
      x: b.x, y: b.y, width: TREE_BOX_W, height: TREE_BOX_H, rx: 8,
      fill: isSelf ? '#5b37b7' : '#ece8f6', stroke: isSelf ? '#5b37b7' : '#d8d0ef', 'stroke-width': 1.5,
    }));
    const text = svgEl('text', {
      x: b.cx, y: b.cy - 2, 'text-anchor': 'middle', 'font-size': 12,
      fill: isSelf ? '#ffffff' : '#1c1530', 'font-weight': isSelf ? 700 : 600,
    });
    text.textContent = b.person.name.length > 6 ? b.person.name.slice(0, 6) + '…' : b.person.name;
    g.appendChild(text);
    if (subLabel) {
      const sub = svgEl('text', {
        x: b.cx, y: b.cy + 14, 'text-anchor': 'middle', 'font-size': 9,
        fill: isSelf ? 'rgba(255,255,255,0.85)' : '#8a84a0',
      });
      sub.textContent = subLabel;
      g.appendChild(sub);
    }
    svg.appendChild(g);
  };

  grandparentsBoxGroups.forEach((grp) => grp.boxes.forEach((b, i) => drawBox(b, false, grp.items[i].label, 'grandparent')));
  parentsBoxes.forEach((b, i) => drawBox(b, false, parentEntries[i].label, parentEntries[i].rel));
  midBoxes.forEach((b, i) => {
    if (i < selfRowPeople.length) {
      const isSelf = b.person.id === p.id;
      drawBox(b, isSelf, isSelf ? '' : '兄弟姉妹', isSelf ? 'self' : 'sibling');
    } else {
      drawBox(b, false, '配偶者', 'spouse');
    }
  });
  childrenBoxes.forEach((b) => {
    const isAdopted = adoptedChildren.some((c) => c.id === b.person.id);
    drawBox(b, false, isAdopted ? '養子' : '', isAdopted ? 'adoptedChild' : 'child');
  });
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
    await refreshAll();
    await autoLinkParentsAsSpouses(newId, focus.motherId);
  } else if (relation === 'mother') {
    const newId = await DB.addPerson(base);
    focus.motherId = newId;
    await DB.updatePerson(focus);
    await refreshAll();
    await autoLinkParentsAsSpouses(focus.fatherId, newId);
  } else if (relation === 'adoptiveFather') {
    const newId = await DB.addPerson(base);
    focus.adoptiveFatherId = newId;
    await DB.updatePerson(focus);
  } else if (relation === 'adoptiveMother') {
    const newId = await DB.addPerson(base);
    focus.adoptiveMotherId = newId;
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

// 家系図の削除モードで人物ボックスをタップした時、本人からその関係を解除する
async function treeDeleteRelation(personId, relation) {
  const focus = personById(familyTreeFocusId);
  if (!focus) return;
  if (relation === 'self') return; // 本人は人物の削除画面からのみ消せる
  if (relation === 'sibling') {
    alert('兄弟姉妹は共有している父・母の設定を変えないと解除できません(人物の編集画面から行ってください)');
    return;
  }
  if (relation === 'grandparent') {
    alert('祖父母との関係は、間にいる親(父・母など)を選んでその人物の編集画面から変更してください');
    return;
  }
  const target = personById(personId);
  const name = target ? target.name : '?';
  const labelMap = {
    father: '父', mother: '母', adoptiveFather: '養父', adoptiveMother: '養母',
    spouse: '配偶者', child: '子', adoptedChild: '養子',
  };
  if (!confirm(`「${name}」との関係(${labelMap[relation] || relation})を解除しますか?\n(人物自体は削除されません)`)) return;

  if (relation === 'father') { focus.fatherId = null; await DB.updatePerson(focus); }
  else if (relation === 'mother') { focus.motherId = null; await DB.updatePerson(focus); }
  else if (relation === 'adoptiveFather') { focus.adoptiveFatherId = null; await DB.updatePerson(focus); }
  else if (relation === 'adoptiveMother') { focus.adoptiveMotherId = null; await DB.updatePerson(focus); }
  else if (relation === 'spouse') {
    focus.spouseIds = (focus.spouseIds || []).filter((id) => id !== personId);
    await DB.updatePerson(focus);
    if (target) {
      target.spouseIds = (target.spouseIds || []).filter((id) => id !== focus.id);
      await DB.updatePerson(target);
    }
  } else if (relation === 'child' && target) {
    if (target.fatherId === focus.id) target.fatherId = null;
    if (target.motherId === focus.id) target.motherId = null;
    await DB.updatePerson(target);
  } else if (relation === 'adoptedChild' && target) {
    if (target.adoptiveFatherId === focus.id) target.adoptiveFatherId = null;
    if (target.adoptiveMotherId === focus.id) target.adoptiveMotherId = null;
    await DB.updatePerson(target);
  }
  await refreshAll();
  renderFamilyTree();
}

// ===== 年代検索(その年に何が起きていて、誰が何をしていたか) =====
function yearWithinEvent(ev, year) {
  const end = ev.endYear != null ? ev.endYear : ev.year;
  return year >= ev.year && year <= end;
}

// 生年・没年(手入力/出来事どちらか)から、その年にまだ生まれていない・すでに死亡している人物を除外する。
// 情報が無い場合は「否定できない」として表示対象に含める
function personRelevantAtYear(p, year) {
  if (p.birthYear != null && p.birthYear > year) return false;
  if (p.deathYear != null && p.deathYear < year) return false;
  const death = getDeathInfo(p.id);
  if (death && eventTimeKey(death) < year * 100) return false;
  return true;
}

function activePeriodItems(list, key, year) {
  return (list || []).filter((r) => (r.startYear ?? -Infinity) <= year && (r.endYear ?? Infinity) >= year).map((r) => r[key]);
}

// 人物詳細の「年代で見る」: 生年を起点に、役職・所属・参加した出来事から分かる最後の年までをプルダウンの範囲にする
function personYearRange(p) {
  const min = p.birthYear ?? 0;
  const candidates = [];
  if (p.deathYear != null) candidates.push(p.deathYear);
  (p.roles || []).forEach((r) => { if (r.startYear != null) candidates.push(r.startYear); if (r.endYear != null) candidates.push(r.endYear); });
  (p.affiliations || []).forEach((a) => { if (a.startYear != null) candidates.push(a.startYear); if (a.endYear != null) candidates.push(a.endYear); });
  (p.qualifications || []).forEach((q) => { if (q.startYear != null) candidates.push(q.startYear); if (q.endYear != null) candidates.push(q.endYear); });
  (p.medals || []).forEach((m) => { if (m.startYear != null) candidates.push(m.startYear); });
  events.filter((ev) => (ev.participants || []).some((pt) => pt.personId === p.id)).forEach((ev) => {
    candidates.push(ev.year);
    if (ev.endYear != null) candidates.push(ev.endYear);
  });
  const max = candidates.length ? Math.max(...candidates, min) : min + 100;
  return { min, max: Math.min(Math.max(max, min), 3000) };
}

function renderPersonYearSelect(p) {
  const sel = document.getElementById('person-year-select');
  const { min, max } = personYearRange(p);
  let opts = '<option value="">年を選択</option>';
  for (let y = min; y <= max; y++) opts += `<option value="${y}">${y}年</option>`;
  sel.innerHTML = opts;
  sel.value = '';
  document.getElementById('person-year-result').innerHTML = '';
}

function openPersonYearView(id) {
  personYearFocusId = id;
  navigateTo('view-person-year');
}

function renderPersonYearView() {
  const p = personById(personYearFocusId);
  if (!p) { goBack(); return; }
  document.getElementById('person-year-view-title').textContent = `${p.name}の年代`;
  renderPersonYearSelect(p);
}

function renderPersonYearResult(p, yearVal) {
  const resultEl = document.getElementById('person-year-result');
  if (yearVal === '' || yearVal == null) { resultEl.innerHTML = ''; return; }
  const year = Number(yearVal);
  const age = personAgeAt(p, year);
  const activeRoles = activePeriodItems(p.roles, 'role', year);
  const activeAffiliations = activePeriodItems(p.affiliations, 'affiliation', year);
  const activeQualifications = activePeriodItems(p.qualifications, 'qualification', year);
  const earnedMedals = (p.medals || []).filter((m) => m.startYear != null && m.startYear <= year).map((m) => m.medal);
  const yearEvents = events.filter((ev) => (ev.participants || []).some((pt) => pt.personId === p.id) && yearWithinEvent(ev, year))
    .sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  const subParts = [
    age !== null ? `${age}歳` : '', activeRoles.join('・'), activeAffiliations.join('・'),
    activeQualifications.length ? `資格:${activeQualifications.join('・')}` : '',
    earnedMedals.length ? `勲章:${earnedMedals.join('・')}` : '',
  ].filter(Boolean);
  resultEl.innerHTML = `
    <div class="detail-sub">${escapeHtml(subParts.join(' ・ ') || 'この年についての情報はありません')}</div>
    <ul class="timeline" style="padding:0;">
      ${yearEvents.map((ev) => `<li class="timeline-item" data-event-id="${ev.id}">
        <div class="timeline-year">${formatEventTime(ev)}</div>
        <div class="timeline-body"><div class="timeline-title">${escapeHtml(ev.title)}</div></div>
      </li>`).join('')}
    </ul>`;
}

function renderYearLookup() {
  const val = document.getElementById('year-lookup-input').value;
  const eventsListEl = document.getElementById('year-lookup-events');
  const eventsEmptyEl = document.getElementById('year-lookup-events-empty');
  const peopleListEl = document.getElementById('year-lookup-people');
  if (val === '') {
    eventsListEl.innerHTML = '';
    eventsEmptyEl.classList.remove('hidden');
    eventsEmptyEl.textContent = '年を入力すると、その年の出来事と人物の様子が見られます';
    peopleListEl.innerHTML = '';
    return;
  }
  const year = clampYear(val);

  const yearEvents = events.filter((ev) => yearWithinEvent(ev, year)).sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  if (!yearEvents.length) {
    eventsListEl.innerHTML = '';
    eventsEmptyEl.classList.remove('hidden');
    eventsEmptyEl.textContent = `${year}年の出来事は登録されていません`;
  } else {
    eventsEmptyEl.classList.add('hidden');
    eventsListEl.innerHTML = yearEvents.map((ev) => eventListItemHtml(ev, ev.parentEventId != null)).join('');
  }

  const relevant = people.filter((p) => personRelevantAtYear(p, year))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  peopleListEl.innerHTML = relevant.length ? relevant.map((p) => {
    const age = personAgeAt(p, year);
    const activeRoles = activePeriodItems(p.roles, 'role', year);
    const activeAffiliations = activePeriodItems(p.affiliations, 'affiliation', year);
    const subParts = [age !== null ? `${age}歳` : '', activeRoles.join('・'), activeAffiliations.join('・')].filter(Boolean);
    return `<li class="list-item" data-person-id="${p.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(p.name)}</div>
        <div class="list-item-sub">${escapeHtml(subParts.join(' ・ ') || '情報なし')}</div>
      </div>
      <span class="list-item-chevron">›</span>
    </li>`;
  }).join('') : '<li class="empty-state">該当する人物が見つかりません</li>';
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
  'view-year-lookup': renderYearLookup,
  'view-person-year': renderPersonYearView,
  'view-roles': renderRoles,
  'view-bulk-role': openBulkRoleForm,
  'view-organizations': renderOrganizations,
  'view-bulk-affiliation': openBulkAffiliationForm,
};

function wireNav() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });
  document.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => goBack()));
  // 編集フォーム内の入力・ボタン操作を検知して「未保存の変更あり」をマークする(キャンセル/戻るボタン自身は除く)
  const markFormDirty = (e) => { if (!e.target.closest('[data-back]')) formDirty = true; };
  DIRTY_TRACKED_VIEWS.forEach((viewId) => {
    const el = document.getElementById(viewId);
    if (!el) return;
    el.addEventListener('input', markFormDirty);
    el.addEventListener('change', markFormDirty);
    el.addEventListener('click', (e) => { if (e.target.closest('button')) markFormDirty(e); });
  });
  window.addEventListener('beforeunload', (e) => {
    if (!formDirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
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
  document.getElementById('year-lookup-input').addEventListener('input', renderYearLookup);

  document.querySelectorAll('#view-people .filter-chips').forEach((bar) => bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sort]');
    if (!chip) return;
    peopleSortMode = chip.dataset.sort;
    bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderPeople();
  }));

  document.querySelectorAll('#view-events .filter-chips').forEach((bar) => bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    eventsCategoryFilter = chip.dataset.category;
    bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderEvents();
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
  delegate('year-lookup-events', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('year-lookup-people', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('roles-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('person-relationships', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('organizations-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));

  document.getElementById('roles-search-input').addEventListener('input', renderRoles);
  document.getElementById('bulk-role-person-search').addEventListener('input', renderBulkRolePersonList);
  document.getElementById('bulk-role-person-list').addEventListener('click', (e) => {
    const row = e.target.closest('.list-item-check');
    if (!row) return;
    const pid = Number(row.dataset.personId);
    const checkbox = row.querySelector('.bulk-role-check');
    if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
    if (checkbox.checked) bulkRoleCheckedIds.add(pid); else bulkRoleCheckedIds.delete(pid);
  });
  document.getElementById('bulk-role-save-btn').addEventListener('click', async () => {
    const role = document.getElementById('bulk-role-name').value.trim();
    if (!role) { alert('役職名を入力してください'); return; }
    if (!bulkRoleCheckedIds.size) { alert('対象の人物を選んでください'); return; }
    const startVal = document.getElementById('bulk-role-start').value;
    const endVal = document.getElementById('bulk-role-end').value;
    const startYear = startVal ? clampYear(startVal) : null;
    const endYear = endVal ? clampYear(endVal) : null;
    for (const pid of bulkRoleCheckedIds) {
      const p = personById(pid);
      if (!p) continue;
      p.roles = [...(p.roles || []), { role, startYear, endYear }];
      await DB.updatePerson(p);
    }
    await refreshAll();
    goBack();
  });

  document.getElementById('organizations-search-input').addEventListener('input', renderOrganizations);
  document.getElementById('bulk-affiliation-person-search').addEventListener('input', renderBulkAffiliationPersonList);
  document.getElementById('bulk-affiliation-person-list').addEventListener('click', (e) => {
    const row = e.target.closest('.list-item-check');
    if (!row) return;
    const pid = Number(row.dataset.personId);
    const checkbox = row.querySelector('.bulk-affiliation-check');
    if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
    if (checkbox.checked) bulkAffiliationCheckedIds.add(pid); else bulkAffiliationCheckedIds.delete(pid);
  });
  document.getElementById('bulk-affiliation-save-btn').addEventListener('click', async () => {
    const affiliation = document.getElementById('bulk-affiliation-name').value.trim();
    if (!affiliation) { alert('組織名を入力してください'); return; }
    if (!bulkAffiliationCheckedIds.size) { alert('対象の人物を選んでください'); return; }
    const startVal = document.getElementById('bulk-affiliation-start').value;
    const endVal = document.getElementById('bulk-affiliation-end').value;
    const startYear = startVal ? clampYear(startVal) : null;
    const endYear = endVal ? clampYear(endVal) : null;
    for (const pid of bulkAffiliationCheckedIds) {
      const p = personById(pid);
      if (!p) continue;
      p.affiliations = [...(p.affiliations || []), { affiliation, startYear, endYear }];
      await DB.updatePerson(p);
    }
    await refreshAll();
    goBack();
  });
}

function wireDetailActions() {
  document.getElementById('person-edit-btn').addEventListener('click', () => openPersonForm(currentPersonId));
  document.getElementById('person-delete-btn').addEventListener('click', () => askConfirm(() => deletePerson(currentPersonId)));
  document.getElementById('person-year-select').addEventListener('change', (e) => {
    const p = personById(personYearFocusId);
    if (p) renderPersonYearResult(p, e.target.value);
  });
  document.getElementById('person-year-result').addEventListener('click', (e) => {
    const el = e.target.closest('[data-event-id]');
    if (el) openEventDetail(Number(el.dataset.eventId));
  });
  document.getElementById('event-edit-btn').addEventListener('click', () => openEventForm(currentEventId));
  document.getElementById('event-delete-btn').addEventListener('click', () => askConfirm(() => deleteEvent(currentEventId)));
  document.getElementById('event-map-btn').addEventListener('click', () => { mapEditingEventId = currentEventId; navigateTo('view-event-map-editor'); });
  document.getElementById('event-add-child-btn').addEventListener('click', () => openEventForm(null, currentEventId));
  document.getElementById('person-tree-btn').addEventListener('click', () => { familyTreeFocusId = currentPersonId; navigateTo('view-family-tree'); });
  document.getElementById('person-year-btn').addEventListener('click', () => openPersonYearView(currentPersonId));
  document.getElementById('tree-edit-btn').addEventListener('click', () => openPersonForm(familyTreeFocusId));
  document.getElementById('tree-delete-toggle').addEventListener('click', (e) => {
    treeDeleteMode = !treeDeleteMode;
    e.currentTarget.classList.toggle('active', treeDeleteMode);
    document.getElementById('tree-delete-hint').style.display = treeDeleteMode ? '' : 'none';
  });
  document.getElementById('view-family-tree').addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-tree-add]');
    if (addBtn) { treeAddPerson(addBtn.dataset.treeAdd); return; }
    const box = e.target.closest('[data-tree-person]');
    if (!box) return;
    if (treeDeleteMode) {
      treeDeleteMode = false;
      document.getElementById('tree-delete-toggle').classList.remove('active');
      document.getElementById('tree-delete-hint').style.display = 'none';
      treeDeleteRelation(Number(box.dataset.treePerson), box.dataset.treeRelation);
      return;
    }
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

  // プルダウンで「+ 新しい人物を作成...」を選んだ時、その場で名前を聞いて人物を作り選択状態にする
  document.getElementById('person-form-father').addEventListener('change', async (e) => {
    if (e.target.value !== NEW_PERSON_OPTION) return;
    const name = (prompt('父の名前を入力してください') || '').trim();
    const newId = name ? await resolvePersonByName(name, editingPersonId) : null;
    populatePersonFormSelects({ father: newId != null ? String(newId) : '' });
  });
  document.getElementById('person-form-mother').addEventListener('change', async (e) => {
    if (e.target.value !== NEW_PERSON_OPTION) return;
    const name = (prompt('母の名前を入力してください') || '').trim();
    const newId = name ? await resolvePersonByName(name, editingPersonId) : null;
    populatePersonFormSelects({ mother: newId != null ? String(newId) : '' });
  });

  document.getElementById('event-form-add-btn').addEventListener('click', () => {
    const sel = document.getElementById('event-form-add-person');
    const personId = Number(sel.value);
    if (!personId || draftParticipants.some((p) => p.personId === personId)) return;
    draftParticipants.push({ personId, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [] });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });

  document.getElementById('event-form-new-person-btn').addEventListener('click', async () => {
    const name = (prompt('新しい人物の名前を入力してください') || '').trim();
    if (!name) return;
    const personId = await DB.addPerson({ name, kana: '', youmei: '', roles: [], birthYear: null, deathYear: null, createdAt: Date.now() });
    await refreshAll();
    draftParticipants.push({ personId, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [] });
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
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const pid = Number(removeBtn.dataset.remove);
      draftParticipants = draftParticipants.filter((p) => p.personId !== pid);
      draftParticipants.forEach((p) => {
        p.killedPersonIds = killedIdsOf(p).filter((id) => id !== pid);
        p.injuredPersonIds = injuredIdsOf(p).filter((id) => id !== pid);
      });
      renderEventFormParticipants();
      renderAddPersonSelect();
      return;
    }
    const row = e.target.closest('.participant-row-wrap');
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const draft = draftParticipants.find((p) => p.personId === pid);
    if (!draft) return;

    const killAdd = e.target.closest('.pf-kill-add');
    if (killAdd) {
      const sel = row.querySelector('.pf-kill');
      const targetId = sel.value ? Number(sel.value) : null;
      if (targetId != null) {
        // 討ち取った相手を1人追加する(複数人討ち取った場合は何度でも追加できる)
        draft.killedPersonIds = [...killedIdsOf(draft), targetId];
        const victim = draftParticipants.find((p) => p.personId === targetId);
        if (victim) victim.status = '死亡';
        renderEventFormParticipants();
      }
      return;
    }
    const injureAdd = e.target.closest('.pf-injure-add');
    if (injureAdd) {
      const sel = row.querySelector('.pf-injure');
      const targetId = sel.value ? Number(sel.value) : null;
      if (targetId != null) {
        draft.injuredPersonIds = [...injuredIdsOf(draft), targetId];
        const injured = draftParticipants.find((p) => p.personId === targetId);
        if (injured && injured.status !== '死亡') injured.status = '負傷';
        renderEventFormParticipants();
      }
      return;
    }
    const killRemove = e.target.closest('[data-kill-remove]');
    if (killRemove) {
      draft.killedPersonIds = killedIdsOf(draft).filter((id) => id !== Number(killRemove.dataset.killRemove));
      renderEventFormParticipants();
      return;
    }
    const injureRemove = e.target.closest('[data-injure-remove]');
    if (injureRemove) {
      draft.injuredPersonIds = injuredIdsOf(draft).filter((id) => id !== Number(injureRemove.dataset.injureRemove));
      renderEventFormParticipants();
      return;
    }
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

  document.getElementById('person-qualification-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-qualification-add-start');
    const endEl = document.getElementById('person-qualification-add-end');
    const nameEl = document.getElementById('person-qualification-add-name');
    const qualification = nameEl.value.trim();
    if (!qualification) return;
    qualificationDraftRows.push({
      rowId: nextQualificationRowId(), qualification,
      startYear: startEl.value ? clampYear(startEl.value) : null,
      endYear: endEl.value ? clampYear(endEl.value) : null,
    });
    startEl.value = ''; endEl.value = ''; nameEl.value = '';
    renderQualificationList();
  });

  const qualificationList = document.getElementById('person-qualification-list');
  qualificationList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = qualificationDraftRows.find((q) => q.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pq-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pq-end')) draft.endYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pq-name')) draft.qualification = e.target.value;
  });
  qualificationList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-qualification]');
    if (!btn) return;
    qualificationDraftRows = qualificationDraftRows.filter((q) => q.rowId !== btn.dataset.removeQualification);
    renderQualificationList();
  });

  document.getElementById('person-medal-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-medal-add-start');
    const nameEl = document.getElementById('person-medal-add-name');
    const medal = nameEl.value.trim();
    if (!medal) return;
    medalDraftRows.push({ rowId: nextMedalRowId(), medal, startYear: startEl.value ? clampYear(startEl.value) : null });
    startEl.value = ''; nameEl.value = '';
    renderMedalList();
  });

  const medalList = document.getElementById('person-medal-list');
  medalList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = medalDraftRows.find((m) => m.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pmd-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pmd-name')) draft.medal = e.target.value;
  });
  medalList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-medal]');
    if (!btn) return;
    medalDraftRows = medalDraftRows.filter((m) => m.rowId !== btn.dataset.removeMedal);
    renderMedalList();
  });

  document.getElementById('person-ability-add-btn').addEventListener('click', () => {
    const nameEl = document.getElementById('person-ability-add-name');
    const ability = nameEl.value.trim();
    if (!ability) return;
    abilityDraftRows.push({ rowId: nextAbilityRowId(), ability });
    nameEl.value = '';
    renderAbilityList();
  });
  document.getElementById('person-ability-list').addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = abilityDraftRows.find((a) => a.rowId === row.dataset.rowId);
    if (draft && e.target.classList.contains('pab-name')) draft.ability = e.target.value;
  });
  document.getElementById('person-ability-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-ability]');
    if (!btn) return;
    abilityDraftRows = abilityDraftRows.filter((a) => a.rowId !== btn.dataset.removeAbility);
    renderAbilityList();
  });

  document.getElementById('person-skill-add-btn').addEventListener('click', () => {
    const nameEl = document.getElementById('person-skill-add-name');
    const skill = nameEl.value.trim();
    if (!skill) return;
    skillDraftRows.push({ rowId: nextSkillRowId(), skill });
    nameEl.value = '';
    renderSkillList();
  });
  document.getElementById('person-skill-list').addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = skillDraftRows.find((s) => s.rowId === row.dataset.rowId);
    if (draft && e.target.classList.contains('psk-name')) draft.skill = e.target.value;
  });
  document.getElementById('person-skill-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-skill]');
    if (!btn) return;
    skillDraftRows = skillDraftRows.filter((s) => s.rowId !== btn.dataset.removeSkill);
    renderSkillList();
  });

  document.getElementById('person-relationship-add-btn').addEventListener('click', async () => {
    const personSelectEl = document.getElementById('person-relationship-add-person');
    const typeEl = document.getElementById('person-relationship-add-type');
    const type = typeEl.value.trim();
    if (!type) return;
    const pid = await resolvePersonFromSelect(personSelectEl, '相手');
    if (pid == null || pid === editingPersonId) { renderPersonNameDatalist(); return; }
    if (relationshipDraftRows.some((r) => r.personId === pid && r.type === type)) { typeEl.value = ''; renderPersonNameDatalist(); return; }
    relationshipDraftRows.push({ rowId: nextRelationshipRowId(), personId: pid, type });
    typeEl.value = '';
    renderRelationshipList();
    renderPersonNameDatalist();
  });
  document.getElementById('person-relationship-list').addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = relationshipDraftRows.find((r) => r.rowId === row.dataset.rowId);
    if (draft && e.target.classList.contains('prl-type')) draft.type = e.target.value;
  });
  document.getElementById('person-relationship-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-relationship]');
    if (!btn) return;
    relationshipDraftRows = relationshipDraftRows.filter((r) => r.rowId !== btn.dataset.removeRelationship);
    renderRelationshipList();
  });

  document.getElementById('person-spouse-add-btn').addEventListener('click', async () => {
    const select = document.getElementById('person-spouse-add');
    const pid = await resolvePersonFromSelect(select, '配偶者');
    if (pid == null || pid === editingPersonId || spouseDraftIds.includes(pid)) { renderPersonNameDatalist(); return; }
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
