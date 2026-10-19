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
const ROLE_CATEGORIES = ['軍部', '国', '家']; // 役職の分類(固定の3種、未設定もありえる)
// 強さのティア(強い順)。基準はS/A/B/Cの4つで共通、+/-は同ランク内の上位・下位
const STRENGTH_TIERS = ['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'];
const STRENGTH_TIER_RANGES = {
  'S+': '97〜100', S: '93〜96', 'S-': '90〜92',
  'A+': '83〜89', A: '76〜82', 'A-': '70〜75',
  'B+': '63〜69', B: '56〜62', 'B-': '50〜55',
  'C+': '33〜49', C: '17〜32', 'C-': '0〜16',
};
const STRENGTH_TIER_RANK = Object.fromEntries(STRENGTH_TIERS.map((t, i) => [t, STRENGTH_TIERS.length - i])); // 大きいほど強い

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

// 享年(数え年): 没年-生年+1。没年は手入力(deathYear)優先、未入力なら死亡扱いの出来事の年から推測する
function kyonenOf(p) {
  if (p.birthYear == null) return null;
  const death = getDeathInfo(p.id);
  const deathYear = p.deathYear != null ? p.deathYear : (death ? death.year : null);
  if (deathYear == null) return null;
  return deathYear - p.birthYear + 1;
}

function formatPersonYears(p) {
  if (p.birthYear == null && p.deathYear == null) return '';
  const kyonen = kyonenOf(p);
  return `${p.birthYear ?? '?'}年〜${p.deathYear != null ? `${p.deathYear}年` : ''}${kyonen != null ? `(享年${kyonen})` : ''}`;
}

// 陣営の推移を「東軍(1590年) → 西軍(1600年)」のように矢印で繋げて表示する(所属年の昇順)
function formatFactionHistory(p) {
  const list = (p.factions || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  return list.map((f) => (f.startYear != null ? `${f.faction}(${f.startYear}年)` : f.faction)).join(' → ');
}

// 現時点(最後に所属した)陣営だけを返す。出来事の参加者に追加する時の初期値に使う
function currentFactionOf(p) {
  const list = (p.factions || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  return list.length ? list[list.length - 1].faction : '';
}

// 強さ(ティア+点数)の推移を「A 80(1590年) → S 95(1600年)」のように矢印で繋げて表示する(年代の昇順)
function formatStrengthHistory(p) {
  const list = (p.strength || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  return list.map((s) => {
    const label = s.score != null && s.score !== '' ? `${s.tier} ${s.score}` : s.tier;
    return s.startYear != null ? `${label}(${s.startYear}年)` : label;
  }).join(' → ');
}

// ソート比較用の数値(ティアを優先し、同ティア内は点数で比較。未設定(null)は常に最下位)
function strengthRankValue(entry) {
  if (!entry || !entry.tier) return -Infinity;
  return (STRENGTH_TIER_RANK[entry.tier] || 0) * 1000 + (Number(entry.score) || 0);
}

// 現時点(一番新しく登録した)強さ
function currentStrengthOf(p) {
  const list = (p.strength || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  return list.length ? list[list.length - 1] : null;
}

// これまでで一番強かった時点(最高ティア・同ティアなら最高点)
function maxStrengthOf(p) {
  const list = p.strength || [];
  if (!list.length) return null;
  return list.reduce((best, cur) => (strengthRankValue(cur) > strengthRankValue(best) ? cur : best), list[0]);
}

// 同じ資格名を複数回取得している場合(初段→二段のような昇格の記録等)は、最後に取得した1件だけを残す
function latestQualificationsOf(p) {
  const byName = new Map();
  (p.qualifications || []).forEach((q) => {
    const prev = byName.get(q.qualification);
    if (!prev || (q.startYear ?? -Infinity) >= (prev.startYear ?? -Infinity)) byName.set(q.qualification, q);
  });
  return [...byName.values()];
}

// この人物が参加したすべての出来事を通じて、討ち取った相手・負傷させた相手の名前を集める(重複は除く)
function combatSummaryOf(p) {
  const killed = new Set(), injured = new Set();
  events.forEach((ev) => {
    const part = (ev.participants || []).find((pt) => pt.personId === p.id);
    if (!part) return;
    killedIdsOf(part).forEach((id) => { const o = personById(id); if (o) killed.add(o.name); });
    injuredIdsOf(part).forEach((id) => { const o = personById(id); if (o) injured.add(o.name); });
  });
  return { killed: [...killed], injured: [...injured] };
}

// 生年が分かっている人物だけ、指定した年の時点での年齢(満年齢、月は考慮しない簡易計算)を返す
function personAgeAt(p, year) {
  if (p.birthYear == null || year == null) return null;
  return year - p.birthYear;
}

async function refreshAll() {
  [people, events, organizations] = await Promise.all([DB.getAllPeople(), DB.getAllEvents(), DB.getAllOrganizations()]);
}

// ===== 組織の爵位(年代ごと。爵位が上がる・変わる場合に対応) =====
let organizations = []; // 爵位の候補(公爵〜男爵)は index.html の peerage-datalist。これ以外も自由に入力できる
function peeragesOf(name) {
  const org = organizations.find((o) => o.name === name);
  return ((org && org.peerages) || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
}
// year省略時は一番新しい爵位、指定時はその年の時点の爵位(まだ授かっていなければ空)
function peerageAt(name, year) {
  const list = peeragesOf(name);
  if (year == null) return list.length ? list[list.length - 1].title : '';
  const hit = list.filter((p) => (p.startYear ?? -Infinity) <= year).pop();
  return hit ? hit.title : '';
}
// 「男爵(1200年) → 子爵(1230年)」のような推移
function formatPeerageHistory(name) {
  return peeragesOf(name).map((p) => (p.startYear != null ? `${p.title}(${p.startYear}年)` : p.title)).join(' → ');
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
  refreshIndexTarget(viewId); // renderFnが無い画面(詳細画面など)に移った時にも、右端インデックスバーを隠す
  // 編集中に新しいバージョンを用意してあれば、編集画面を離れたところで切り替える
  if (pendingReload && !UPDATE_BUSY_VIEWS.includes(viewId)) { pendingReload = false; location.reload(); }
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

// 開始年が空欄なら、その人物の生年から(生まれた時から)とみなして表示する
function formatRolePeriod(row, person) {
  const owner = person || row.person;
  const start = row.startYear ?? (owner ? owner.birthYear : null);
  return `${start ?? '?'}年〜${row.endYear != null ? row.endYear + '年' : ''}`;
}

function roleCategoryOptionsHtml(selected) {
  return '<option value="">分類-</option>' + ROLE_CATEGORIES.map((c) => `<option value="${c}" ${selected === c ? 'selected' : ''}>${c}</option>`).join('');
}

function renderRoleList() {
  const listEl = document.getElementById('person-role-list');
  listEl.innerHTML = roleDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pr-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
      <input class="pr-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
      <input class="pr-org" type="text" list="affiliation-datalist" value="${escapeHtml(row.organization || '')}" placeholder="組織">
      <input class="pr-name" type="text" value="${escapeHtml(row.role || '')}" placeholder="役職名">
      <select class="pr-category">${roleCategoryOptionsHtml(row.category)}</select>
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

// ===== 人物フォーム: 陣営(複数、年代順。寝返り等で陣営が変わる場合に対応) =====
let factionDraftRows = [];
let factionRowSeq = 0;
function nextFactionRowId() { return 'faction' + (factionRowSeq++); }

function renderFactionList() {
  const listEl = document.getElementById('person-faction-list');
  listEl.innerHTML = factionDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pfc-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="所属年">
      <input class="pfc-name" type="text" value="${escapeHtml(row.faction || '')}" placeholder="陣営名" list="person-faction-datalist">
      <button type="button" class="remove-btn" data-remove-faction="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 強さ(複数、年代順。ティア+点数で成長を記録) =====
let strengthDraftRows = [];
let strengthRowSeq = 0;
function nextStrengthRowId() { return 'strength' + (strengthRowSeq++); }

function strengthTierOptionsHtml(selected) {
  return STRENGTH_TIERS.map((t) => `<option value="${t}" ${selected === t ? 'selected' : ''}>${t}(${STRENGTH_TIER_RANGES[t]})</option>`).join('');
}

function renderStrengthList() {
  const listEl = document.getElementById('person-strength-list');
  listEl.innerHTML = strengthDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pst-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="年">
      <select class="pst-tier">${strengthTierOptionsHtml(row.tier)}</select>
      <input class="pst-score" type="number" value="${row.score ?? ''}" placeholder="点数(任意)">
      <button type="button" class="remove-btn" data-remove-strength="${row.rowId}">×</button>
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
      <input class="pmd-rank" type="text" value="${escapeHtml(row.rank || '')}" placeholder="階級(例: 勲一等)">
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

// ===== 人物フォーム: 武器(複数、名前のみ)編集 =====
let weaponDraftRows = [];
let weaponRowSeq = 0;
function nextWeaponRowId() { return 'weapon' + (weaponRowSeq++); }

function renderWeaponList() {
  const listEl = document.getElementById('person-weapon-list');
  listEl.innerHTML = weaponDraftRows.map((row) => `<li class="participant-row summary-row" data-row-id="${row.rowId}">
      <input class="pwp-name" type="text" value="${escapeHtml(row.weapon || '')}" placeholder="武器名">
      <button type="button" class="remove-btn" data-remove-weapon="${row.rowId}">×</button>
    </li>`).join('');
}

// ===== 人物フォーム: 技(複数、名前のみ)編集 =====
let skillDraftRows = [];
let skillRowSeq = 0;
function nextSkillRowId() { return 'skill' + (skillRowSeq++); }

function renderSkillList() {
  const listEl = document.getElementById('person-skill-list');
  listEl.innerHTML = skillDraftRows.map((row) => `<li class="skill-row" data-row-id="${row.rowId}">
      <div class="skill-row-top">
        <input class="psk-name" type="text" value="${escapeHtml(row.skill || '')}" placeholder="技名">
        <button type="button" class="remove-btn" data-remove-skill="${row.rowId}">×</button>
      </div>
      <textarea class="psk-desc" placeholder="説明(任意)">${escapeHtml(row.description || '')}</textarea>
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
  // 陣営は人物自身のfactionsと、出来事の参加者に付けたfactionの両方から候補を集める(表記ゆれ防止)
  const factionNames = new Set();
  people.forEach((p) => (p.factions || []).forEach((f) => { if (f.faction) factionNames.add(f.faction); }));
  events.forEach((ev) => (ev.participants || []).forEach((pt) => { if (pt.faction) factionNames.add(pt.faction); }));
  document.getElementById('person-faction-datalist').innerHTML =
    Array.from(factionNames).map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  populatePersonFormSelects();
}

// ===== 人物フォーム: 既存の人物をプルダウンから選べるようにする共通処理 =====
// (datalistはiOS Safariでの対応が不安定で、見えない/選べないことがあるため使わない)
const NEW_PERSON_OPTION = '__new__';

// 父母欄は現在選択中の値を保持しつつ表示を更新し、子・配偶者・人間関係の追加欄は次の1件を選べるよう空に戻す。
// overridesで渡したものだけ選択値を明示的に変更する(新規作成直後など)
function populatePersonFormSelects(overrides) {
  overrides = overrides || {};
  const fatherEl = document.getElementById('person-form-father');
  const motherEl = document.getElementById('person-form-mother');
  const curFather = 'father' in overrides ? overrides.father : fatherEl.value;
  const curMother = 'mother' in overrides ? overrides.mother : motherEl.value;
  fatherEl.value = curFather || '';
  motherEl.value = curMother || '';
  updatePersonPickerButtonLabel('person-form-father', 'person-form-father-picker', '(未設定)');
  updatePersonPickerButtonLabel('person-form-mother', 'person-form-mother-picker', '(未設定)');
  ['person-spouse-add', 'person-child-add', 'person-adopted-child-add', 'person-relationship-add-person'].forEach((hiddenId) => {
    document.getElementById(hiddenId).value = '';
    updatePersonPickerButtonLabel(hiddenId, `${hiddenId}-picker`, '選択してください');
  });
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
    const name = ((await promptText(`${promptLabel}の名前を入力してください`)) || '').trim();
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
  const episodeEl = document.getElementById('person-form-episode');
  let initialFatherId = '';
  let initialMotherId = '';
  if (id) {
    const p = personById(id);
    nameEl.value = p.name || '';
    kanaEl.value = p.kana || '';
    youmeiEl.value = p.youmei || '';
    maidenNameEl.value = p.maidenName || '';
    // 旧データ(単一のp.faction)しかない場合はそれを1件目として引き継ぐ
    factionDraftRows = (p.factions || (p.faction ? [{ faction: p.faction, startYear: null }] : []))
      .map((f) => ({ rowId: nextFactionRowId(), faction: f.faction, startYear: f.startYear }));
    strengthDraftRows = (p.strength || []).map((s) => ({ rowId: nextStrengthRowId(), tier: s.tier || 'C', score: s.score ?? '', startYear: s.startYear }));
    genpukuYearEl.value = p.genpukuYear ?? '';
    genpukuMonthEl.value = p.genpukuMonth ?? '';
    episodeEl.value = p.episode || '';
    birthEl.value = p.birthYear ?? '';
    deathEl.value = p.deathYear ?? '';
    summaryDraftRows = loadSummaryRowsForPerson(id);
    roleDraftRows = (p.roles || []).map((r) => ({ rowId: nextRoleRowId(), role: r.role, category: r.category || '', startYear: r.startYear, endYear: r.endYear, organization: r.organization || '' }));
    affiliationDraftRows = (p.affiliations || []).map((a) => ({ rowId: nextAffiliationRowId(), affiliation: a.affiliation, startYear: a.startYear, endYear: a.endYear }));
    qualificationDraftRows = (p.qualifications || []).map((q) => ({ rowId: nextQualificationRowId(), qualification: q.qualification, startYear: q.startYear, endYear: q.endYear }));
    medalDraftRows = (p.medals || []).map((m) => ({ rowId: nextMedalRowId(), medal: m.medal, rank: m.rank, startYear: m.startYear }));
    abilityDraftRows = (p.abilities || []).map((a) => ({ rowId: nextAbilityRowId(), ability: a.ability }));
    weaponDraftRows = (p.weapons || []).map((w) => ({ rowId: nextWeaponRowId(), weapon: w.weapon }));
    skillDraftRows = (p.skills || []).map((s) => ({ rowId: nextSkillRowId(), skill: s.skill, description: s.description }));
    relationshipDraftRows = (p.relationships || []).map((r) => ({ rowId: nextRelationshipRowId(), personId: r.personId, type: r.type }));
    initialFatherId = p.fatherId != null ? String(p.fatherId) : '';
    initialMotherId = p.motherId != null ? String(p.motherId) : '';
    spouseDraftIds = (p.spouseIds || []).slice();
  } else {
    nameEl.value = ''; kanaEl.value = ''; youmeiEl.value = ''; maidenNameEl.value = '';
    genpukuYearEl.value = ''; genpukuMonthEl.value = ''; birthEl.value = ''; deathEl.value = ''; episodeEl.value = '';
    summaryDraftRows = [];
    roleDraftRows = [];
    affiliationDraftRows = [];
    qualificationDraftRows = [];
    medalDraftRows = [];
    factionDraftRows = [];
    strengthDraftRows = [];
    abilityDraftRows = [];
    weaponDraftRows = [];
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
  document.getElementById('person-role-add-category').value = '';
  document.getElementById('person-affiliation-add-start').value = '';
  document.getElementById('person-affiliation-add-end').value = '';
  document.getElementById('person-affiliation-add-name').value = '';
  document.getElementById('person-qualification-add-start').value = '';
  document.getElementById('person-qualification-add-end').value = '';
  document.getElementById('person-qualification-add-name').value = '';
  document.getElementById('person-medal-add-start').value = '';
  document.getElementById('person-medal-add-name').value = '';
  document.getElementById('person-medal-add-rank').value = '';
  document.getElementById('person-faction-add-start').value = '';
  document.getElementById('person-faction-add-name').value = '';
  document.getElementById('person-strength-add-start').value = '';
  document.getElementById('person-strength-add-tier').innerHTML = strengthTierOptionsHtml('C');
  document.getElementById('person-strength-add-score').value = '';
  document.getElementById('person-skill-add-name').value = '';
  document.getElementById('person-skill-add-description').value = '';
  renderSummaryList();
  renderRoleList();
  renderAffiliationList();
  renderQualificationList();
  renderMedalList();
  renderFactionList();
  renderStrengthList();
  renderAbilityList();
  renderWeaponList();
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
    || (p.factions || []).some((f) => (f.faction || '').toLowerCase().includes(q))
    || (p.roles || []).some((r) => (r.role || '').toLowerCase().includes(q))
    || (p.affiliations || []).some((a) => (a.affiliation || '').toLowerCase().includes(q))
    || (p.abilities || []).some((a) => (a.ability || '').toLowerCase().includes(q))
    || (p.skills || []).some((s) => (s.skill || '').toLowerCase().includes(q)));
  if (!hits.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); emptyEl.textContent = '該当する人物が見つかりません'; return; }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = hits.map((p) => personListItemHtml(p)).join('');
}

function personListItemHtml(p, section = null) {
  const dead = isPersonDead(p);
  const years = formatPersonYears(p);
  const roleNames = [...new Set((p.roles || []).map((r) => r.role).filter(Boolean))].join('・'); // 同じ役職に何度就いても1回だけ出す
  const subParts = [roleNames, years || '生没年未設定'].filter(Boolean);
  return `<li class="list-item" data-person-id="${p.id}"${section != null ? ` data-section="${escapeHtml(section)}"` : ''}>
    <div class="list-item-main">
      <div class="list-item-title">${escapeHtml(p.name)}</div>
      <div class="list-item-sub">${escapeHtml(subParts.join(' ・ '))}${dead ? ' ・ 死亡済' : ''}</div>
    </div>
    ${dead ? '<span class="badge dead">死亡済</span>' : ''}
    <span class="list-item-chevron">›</span>
  </li>`;
}

// ===== 右端のインデックスバー(人物一覧・名前順の時だけ。音楽アプリのあ〜わ/A〜Z/#ジャンプバーと同じ仕組み) =====
const INDEX_LABELS = [...'あかさたなはまやらわ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
const KANA_ROWS = {
  'あ': 'ぁあぃいぅうぇえぉおゔ', 'か': 'かきくけこゕゖ', 'さ': 'さしすせそ', 'た': 'たちつってとっ', 'な': 'なにぬねの',
  'は': 'はひふへほ', 'ま': 'まみむめも', 'や': 'ゃやゅゆょよ', 'ら': 'らりるれろ', 'わ': 'ゎわゐゑをん',
};
const SECTION_INDEX = new Map(INDEX_LABELS.map((l, i) => [l, i]));

// 先頭文字の所属: ひらがな/カタカナ→行の代表(濁音・半濁音・小書きも同じ行)、英字→A〜Z、それ以外(漢字・記号)→#
function sectionOf(str) {
  const c = (str || '').normalize('NFKC').trim().charAt(0);
  if (!c) return '#';
  const h = c.replace(/[ァ-ヶ]/, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  if (/[A-Za-z]/.test(h)) return h.toUpperCase();
  const base = h.normalize('NFD').charAt(0); // 濁点・半濁点を分離して清音にする
  for (const [row, chars] of Object.entries(KANA_ROWS)) if (chars.includes(base)) return row;
  return '#';
}

let indexBarListId = null;

// 右端のインデックスバーを出すか・どの一覧を対象にするかを、今の画面から決める(対応しているのは人物一覧の名前順の時だけ)
function refreshIndexTarget(viewId) {
  const show = viewId === 'view-people' && peopleSortMode === 'name' && people.length > 0;
  indexBarListId = show ? 'people-list' : null;
  document.getElementById('index-bar').classList.toggle('hidden', !show);
  document.getElementById('view-people').classList.toggle('has-index', show);
}

function jumpToSection(label) {
  if (!indexBarListId) return;
  const target = SECTION_INDEX.get(label);
  const listEl = document.getElementById(indexBarListId);
  const view = document.querySelector('.view.active');
  if (!listEl || !view) return;
  const topbar = view.querySelector('.topbar');
  const chips = view.querySelector('.filter-chips');
  const offset = (topbar ? topbar.offsetHeight : 0) + (chips ? chips.offsetHeight : 0);
  const hit = [...listEl.querySelectorAll('[data-section]')].find((el) => SECTION_INDEX.get(el.dataset.section) >= target);
  if (hit) view.scrollTop += hit.getBoundingClientRect().top - view.getBoundingClientRect().top - offset;
}

// 触覚フィードバック(文字が切り替わるたびの「コツッ」)。iOS 17.4以降の <input type=checkbox switch> を
// プログラムから切り替えたときの触覚を利用する。非対応の端末では何も起きない
let hapticLabel = null;
function hapticTick() {
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.setAttribute('aria-hidden', 'true');
      hapticLabel.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      hapticLabel.appendChild(input);
      document.head.appendChild(hapticLabel);
    }
    hapticLabel.click();
    if (navigator.vibrate) navigator.vibrate(8); // Android等
  } catch (e) { /* 触覚が使えなくても動作に影響しない */ }
}

// iOS標準の一覧インデックスと同様: 指が文字の上を移動するたびに触覚+ジャンプする
function setupIndexBar() {
  const bar = document.getElementById('index-bar');
  const spans = INDEX_LABELS.map((l) => {
    const span = document.createElement('span');
    span.textContent = l;
    bar.appendChild(span);
    return span;
  });
  let lastLabel = null;

  const labelAt = (clientY) => {
    const r = bar.getBoundingClientRect();
    const i = Math.min(INDEX_LABELS.length - 1, Math.max(0, Math.floor(((clientY - r.top) / r.height) * INDEX_LABELS.length)));
    return { label: INDEX_LABELS[i], i };
  };
  const touchAt = (clientY) => {
    const { label, i } = labelAt(clientY);
    bar.classList.add('touching');
    spans.forEach((sp, k) => sp.classList.toggle('current', k === i));
    if (label !== lastLabel) {
      lastLabel = label;
      hapticTick();
      jumpToSection(label);
    }
  };
  const release = () => {
    lastLabel = null;
    bar.classList.remove('touching');
    spans.forEach((sp) => sp.classList.remove('current'));
  };

  const onTouch = (e) => { e.preventDefault(); touchAt(e.touches[0].clientY); };
  bar.addEventListener('touchstart', onTouch, { passive: false });
  bar.addEventListener('touchmove', onTouch, { passive: false });
  bar.addEventListener('touchend', release);
  bar.addEventListener('touchcancel', release);
  // PCブラウザ用
  bar.addEventListener('mousedown', (e) => {
    touchAt(e.clientY);
    const move = (ev) => touchAt(ev.clientY);
    const up = () => { release(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// ===== 人物一覧 =====
let peopleSortMode = 'name'; // 'name' | 'birth'
function renderPeople() {
  const listEl = document.getElementById('people-list');
  const emptyEl = document.getElementById('people-empty');
  if (!people.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); refreshIndexTarget('view-people'); return; }
  emptyEl.classList.add('hidden');
  const kanaCompare = (a, b) => (a.kana || a.name || '').localeCompare(b.kana || b.name || '', 'ja');
  const sorted = people.slice().sort((a, b) => {
    if (peopleSortMode === 'birth') return (a.birthYear ?? Infinity) - (b.birthYear ?? Infinity);
    if (peopleSortMode === 'status') {
      const diff = (isPersonDead(a) ? 1 : 0) - (isPersonDead(b) ? 1 : 0);
      return diff !== 0 ? diff : kanaCompare(a, b);
    }
    if (peopleSortMode === 'faction') {
      // 陣営未設定の人物は最後にまとめる(あいうえお順の比較だと空文字が先頭に来てしまうため)
      const fa = currentFactionOf(a) || '', fb = currentFactionOf(b) || '';
      if (!fa && fb) return 1;
      if (fa && !fb) return -1;
      return fa.localeCompare(fb, 'ja') || kanaCompare(a, b);
    }
    if (peopleSortMode === 'strength-latest' || peopleSortMode === 'strength-max') {
      // 最新=一番新しく登録した強さ、最大=これまでで一番強かった時点。どちらも強い順(降順)、同値はあいうえお順
      const getEntry = peopleSortMode === 'strength-latest' ? currentStrengthOf : maxStrengthOf;
      const diff = strengthRankValue(getEntry(b)) - strengthRankValue(getEntry(a));
      return diff !== 0 ? diff : kanaCompare(a, b);
    }
    return kanaCompare(a, b);
  });
  if (peopleSortMode === 'name') {
    // 名前順の時だけ、あ・か・さ…の見出し行を挟む(右端のインデックスバーのジャンプ先になる)
    let lastSection = null;
    listEl.innerHTML = sorted.map((p) => {
      const section = sectionOf(p.kana || p.name);
      const header = section !== lastSection ? `<li class="section-header-row">${escapeHtml(section)}</li>` : '';
      lastSection = section;
      return header + personListItemHtml(p, section);
    }).join('');
  } else if (peopleSortMode === 'status') {
    // 生死順の時は「存命」「死亡済」の見出しで2グループに分ける
    let lastGroup = null;
    listEl.innerHTML = sorted.map((p) => {
      const group = isPersonDead(p) ? '死亡済' : '存命';
      const header = group !== lastGroup ? `<li class="section-header-row">${escapeHtml(group)}</li>` : '';
      lastGroup = group;
      return header + personListItemHtml(p);
    }).join('');
  } else if (peopleSortMode === 'faction') {
    // 陣営別の時は、人物の現時点(最後に所属した)陣営ごとに見出しで分ける。未設定はまとめて最後に出す
    let lastGroup = null;
    listEl.innerHTML = sorted.map((p) => {
      const group = currentFactionOf(p) || '(陣営未設定)';
      const header = group !== lastGroup ? `<li class="section-header-row">${escapeHtml(group)}</li>` : '';
      lastGroup = group;
      return header + personListItemHtml(p);
    }).join('');
  } else if (peopleSortMode === 'strength-latest' || peopleSortMode === 'strength-max') {
    // 強さ順の時は、対象の時点(最新/最大)のティアごとに見出しで分ける。未設定はまとめて最後に出す
    const getEntry = peopleSortMode === 'strength-latest' ? currentStrengthOf : maxStrengthOf;
    let lastGroup = null;
    listEl.innerHTML = sorted.map((p) => {
      const entry = getEntry(p);
      const group = entry ? entry.tier : '(強さ未設定)';
      const header = group !== lastGroup ? `<li class="section-header-row">${escapeHtml(group)}</li>` : '';
      lastGroup = group;
      return header + personListItemHtml(p);
    }).join('');
  } else {
    listEl.innerHTML = sorted.map((p) => personListItemHtml(p)).join('');
  }
  refreshIndexTarget('view-people');
}

// ===== 人物詳細 =====
function renderPersonDetail() {
  const p = personById(currentPersonId);
  if (!p) { goBack(); return; }
  document.getElementById('person-name').textContent = p.name;
  document.getElementById('person-kana').textContent = p.kana || '';
  document.getElementById('person-youmei').textContent = p.youmei ? `幼名: ${p.youmei}` : '';
  document.getElementById('person-maiden-name').textContent = p.maidenName ? `旧姓: ${p.maidenName}` : '';
  document.getElementById('person-faction').textContent = (p.factions || []).length ? `陣営: ${formatFactionHistory(p)}` : '';
  document.getElementById('person-strength').textContent = (p.strength || []).length ? `強さ: ${formatStrengthHistory(p)}` : '';
  document.getElementById('person-genpuku').textContent = p.genpukuYear != null ? `元服: ${formatYearMonth(p.genpukuYear, p.genpukuMonth)}` : '';
  const rolesSorted = (p.roles || []).slice().sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  document.getElementById('person-roles-timeline').innerHTML = rolesSorted.map((r) => `<li class="timeline-item">
      <div class="timeline-year"${(r.startYear ?? p.birthYear) != null ? ` data-year="${r.startYear ?? p.birthYear}"` : ''}>${formatRolePeriod(r, p)}</div>
      <div class="timeline-body"><div class="timeline-title">${r.organization ? `${escapeHtml(r.organization)} ` : ''}${escapeHtml(r.role)}${r.category ? ` <span class="badge">${escapeHtml(r.category)}</span>` : ''}</div></div>
    </li>`).join('');
  document.getElementById('person-relationships').innerHTML = (p.relationships || []).map((r) => {
    const rp = personById(r.personId);
    return `<span class="chip-link" data-person-id="${r.personId}">${escapeHtml(r.type)}: ${escapeHtml(rp ? rp.name : '?')}</span>`;
  }).join('');
  document.getElementById('person-affiliations').textContent = dedupeAffiliations(p.affiliations).map((a) => `${a.affiliation}(${formatRolePeriod(a, p)})`).join('、');
  document.getElementById('person-qualifications').textContent = latestQualificationsOf(p)
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0))
    .map((q) => `${q.qualification}(${formatRolePeriod(q, p)})`).join('、');
  document.getElementById('person-medals').textContent = (p.medals || []).map((m) => {
    const parts = [m.rank, m.startYear != null ? `${m.startYear}年` : null].filter(Boolean);
    return parts.length ? `${m.medal}(${parts.join('・')})` : m.medal;
  }).join('、');
  document.getElementById('person-abilities').textContent = (p.abilities || []).length ? `能力: ${(p.abilities || []).map((a) => a.ability).join('、')}` : '';
  document.getElementById('person-weapons').textContent = (p.weapons || []).length ? `武器: ${(p.weapons || []).map((w) => w.weapon).join('、')}` : '';
  document.getElementById('person-skills').textContent = (p.skills || []).length
    ? `技: ${(p.skills || []).map((s) => s.description ? `${s.skill}(${s.description})` : s.skill).join('、')}`
    : '';
  const combat = combatSummaryOf(p);
  document.getElementById('person-killed').textContent = combat.killed.length ? `討ち取った相手: ${combat.killed.join('・')}` : '';
  document.getElementById('person-injured').textContent = combat.injured.length ? `負傷させた相手: ${combat.injured.join('・')}` : '';
  document.getElementById('person-years').textContent = formatPersonYears(p);
  document.getElementById('person-episode').textContent = p.episode || '';
  document.getElementById('person-episode-label').style.display = p.episode ? '' : 'none';

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
      // この出来事の他の参加者から見て、この人物が「討ち取った相手」に指定されていれば、誰にやられたかを表示する
      const namesOf = (ids) => ids.map((id) => personById(id)).filter(Boolean).map((o) => o.name);
      const byOthers = (idsOf) => namesOf((ev.participants || []).filter((other) => idsOf(other).includes(p.id)).map((other) => other.personId));
      const killedByNames = byOthers(killedIdsOf);
      const injuredByNames = byOthers(injuredIdsOf);
      const killedNames = namesOf(killedIdsOf(part));
      const injuredNames = namesOf(injuredIdsOf(part));
      // 出来事詳細の参加者欄と同じく、誰を討ち取った/誰にやられたかを年表にも出す
      const desc = [
        killedNames.length ? `${killedNames.join('・')}を討ち取った` : '',
        injuredNames.length ? `${injuredNames.join('・')}を負傷させた` : '',
        killedByNames.length ? `${killedByNames.join('・')}に討ち取られた` : '',
        injuredByNames.length ? `${injuredByNames.join('・')}に負傷させられた` : '',
        part.note || ev.description || '',
      ].filter(Boolean).join(' ・ ');
      return `<li class="timeline-item ${isDead ? 'is-dead' : ''}" data-event-id="${ev.id}">
        <div class="timeline-year" data-year="${ev.year}">${formatEventTime(ev)}${age !== null ? `(${age}歳)` : ''}</div>
        <div class="timeline-body">
          <div class="timeline-title">${escapeHtml(ev.title)} <span class="status-pill ${STATUS_CLASS[part.status] || 'unknown'}">${part.status || '不明'}</span></div>
          <div class="timeline-desc">${escapeHtml(desc)}</div>
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
      <div class="list-item-sub">${formatEventTime(ev)} ・ ${participantCountText(ev)}</div>
    </div>
    <span class="list-item-chevron">›</span>
  </li>`;
}

// 「参加者10人(死亡2・負傷3)」のように、生死の内訳も一覧で分かるようにする
function participantCountText(ev) {
  const parts = ev.participants || [];
  const dead = parts.filter((p) => p.status === '死亡').length;
  const injured = parts.filter((p) => p.status === '負傷').length;
  const detail = [dead ? `死亡${dead}` : '', injured ? `負傷${injured}` : ''].filter(Boolean).join('・');
  return `参加者${parts.length}人${detail ? `(${detail})` : ''}`;
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
  // 生存→負傷→不明→死亡の順に並べる(同じ生死の中は登録順のまま)
  const STATUS_ORDER = { 生存: 0, 負傷: 1, 不明: 2, 死亡: 3 };
  const statusRank = (p) => STATUS_ORDER[p.status] ?? 2;
  const participants = (ev.participants || []).slice().sort((a, b) => statusRank(a) - statusRank(b));
  const participantItemHtml = (p) => {
    const person = pm.get(p.personId);
    const age = person ? personAgeAt(person, ev.year) : null;
    const killedNames = killedIdsOf(p).map((id) => pm.get(id)).filter(Boolean).map((o) => o.name);
    const injuredNames = injuredIdsOf(p).map((id) => pm.get(id)).filter(Boolean).map((o) => o.name);
    // 他の参加者の「討ち取った/負傷させた相手」にこの人物が指定されていれば、逆方向(誰にやられたか)も表示する
    const killedByNames = participants.filter((other) => killedIdsOf(other).includes(p.personId))
      .map((other) => pm.get(other.personId)).filter(Boolean).map((o) => o.name);
    const injuredByNames = participants.filter((other) => injuredIdsOf(other).includes(p.personId))
      .map((other) => pm.get(other.personId)).filter(Boolean).map((o) => o.name);
    const subParts = [
      age !== null ? `${age}歳` : '',
      p.tier ? `ティア${p.tier}${p.score != null && p.score !== '' ? ` ${p.score}` : ''}` : '',
      killedNames.length ? `${killedNames.join('・')}を討ち取った` : '',
      injuredNames.length ? `${injuredNames.join('・')}を負傷させた` : '',
      killedByNames.length ? `${killedByNames.join('・')}に討ち取られた` : '',
      injuredByNames.length ? `${injuredByNames.join('・')}に負傷させられた` : '',
      p.note || '',
    ].filter(Boolean);
    return `<li class="list-item" data-person-id="${p.personId}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(person ? person.name : '(不明な人物)')}</div>
        <div class="list-item-sub">${escapeHtml(subParts.join(' ・ '))}</div>
      </div>
      <span class="status-pill ${STATUS_CLASS[p.status] || 'unknown'}">${p.status || '不明'}</span>
      <span class="list-item-chevron">›</span>
    </li>`;
  };
  // 誰か1人でも陣営が設定されていれば、陣営ごとにグループ分けして表示する
  if (participants.some((p) => (p.faction || '').trim())) {
    const groups = new Map();
    participants.forEach((p) => {
      const key = (p.faction || '').trim() || '(陣営未設定)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    listEl.innerHTML = Array.from(groups.entries())
      .map(([faction, items]) => `<li class="list-group-header">${escapeHtml(faction)}</li>${items.map(participantItemHtml).join('')}`)
      .join('');
  } else {
    listEl.innerHTML = participants.map(participantItemHtml).join('');
  }

  // この戦いの時点のティア表: ティアを付けた参加者を強い順に、ティアごとの見出しで並べる
  const tiered = participants.filter((p) => p.tier)
    .sort((a, b) => strengthRankValue(b) - strengthRankValue(a));
  document.getElementById('event-tier-label').style.display = tiered.length ? '' : 'none';
  let lastTier = null;
  document.getElementById('event-tier-table').innerHTML = tiered.map((p) => {
    const person = pm.get(p.personId);
    const header = p.tier !== lastTier ? `<li class="list-group-header">${escapeHtml(p.tier)}</li>` : '';
    lastTier = p.tier;
    const faction = (p.faction || '').trim();
    return `${header}<li class="list-item list-item-indent" data-person-id="${p.personId}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(person ? person.name : '(不明な人物)')}</div>
        <div class="list-item-sub">${escapeHtml([p.score != null && p.score !== '' ? `${p.score}点` : '', faction].filter(Boolean).join(' ・ '))}</div>
      </div>
      <span class="list-item-chevron">›</span>
    </li>`;
  }).join('');

  const wrap = document.getElementById('event-map-preview-wrap');
  const svg = document.getElementById('event-map-preview');
  const shapes = (ev.terrainMap && ev.terrainMap.shapes) || [];
  const placed = (ev.participants || []).filter((p) => p.position);
  const showMap = shapes.length || placed.length;
  document.getElementById('event-map-label').style.display = showMap ? '' : 'none';
  wrap.style.display = showMap ? '' : 'none';
  if (showMap) renderMapSvg(svg, shapes, placed, pm);
  renderMapLegend('event-map-legend', placed);

  const children = events.filter((c) => c.parentEventId === ev.id).sort((a, b) => eventTimeKey(a) - eventTimeKey(b));
  document.getElementById('event-children-list').innerHTML = children.map((c) => `<li class="list-item" data-event-id="${c.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(c.title)}</div>
        <div class="list-item-sub">${formatEventTime(c)} ・ ${participantCountText(c)}</div>
      </div>
      <span class="list-item-chevron">›</span>
    </li>`).join('');
}

// ===== 役職一覧(人物を横断して、役職名ごとにグループ表示) =====
let rolesCategoryFilter = ''; // '' | '軍部' | '国' | '家'
function renderRoles() {
  const q = (document.getElementById('roles-search-input').value || '').trim().toLowerCase();
  const groups = new Map();
  people.forEach((p) => (p.roles || []).forEach((r) => {
    if (!r.role) return;
    if (rolesCategoryFilter && (r.category || '') !== rolesCategoryFilter) return;
    if (!groups.has(r.role)) groups.set(r.role, []);
    groups.get(r.role).push({ person: p, startYear: r.startYear, endYear: r.endYear, organization: r.organization || '' });
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
          <div class="list-item-sub">${row.organization ? `${escapeHtml(row.organization)} ・ ` : ''}${formatRolePeriod(row)}</div>
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
  document.getElementById('bulk-role-category').value = '';
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

// ===== 組織図(家系図のような図で、役職ごとの歴代と所属メンバーを見る) =====
let orgChartName = null;
let orgChartYear = ''; // ''=全期間、数値文字列=その年の時点
function renderOrgChart() {
  const name = orgChartName;
  document.getElementById('org-chart-title').textContent = name ? `${name}の組織図` : '組織図';
  const year = orgChartYear === '' ? null : Number(orgChartYear);
  const activeAt = (item, person) => {
    if (year == null) return true;
    const start = item.startYear ?? (person ? person.birthYear : null);
    return (start ?? -Infinity) <= year && (item.endYear ?? Infinity) >= year;
  };
  const byYear = (a, b) => (a.startYear ?? 0) - (b.startYear ?? 0);

  // 役職ごとの歴代(組織に紐づく役職)と、役職のない所属メンバー
  const roleCols = new Map();
  const roleHolderIds = new Set();
  const years = new Set();
  people.forEach((p) => (p.roles || []).forEach((r) => {
    if (r.organization !== name || !r.role) return;
    roleHolderIds.add(p.id);
    [r.startYear, r.endYear].forEach((y) => { if (y != null) years.add(y); });
    if (!activeAt(r, p)) return;
    if (!roleCols.has(r.role)) roleCols.set(r.role, { role: r.role, category: r.category || '', items: [] });
    roleCols.get(r.role).items.push({ person: p, startYear: r.startYear, endYear: r.endYear });
  }));
  const members = [];
  people.forEach((p) => {
    const affs = dedupeAffiliations(p.affiliations).filter((a) => a.affiliation === name);
    affs.forEach((a) => [a.startYear, a.endYear].forEach((y) => { if (y != null) years.add(y); }));
    if (roleHolderIds.has(p.id)) return; // 役職のある人は役職の列に出す
    const hit = affs.filter((a) => activeAt(a, p)).sort(byYear)[0];
    if (hit) members.push({ person: p, startYear: hit.startYear, endYear: hit.endYear });
  });

  // 時点の選択肢: 役職・所属・爵位に出てくる年の最小〜最大
  peeragesOf(name).forEach((pg) => { if (pg.startYear != null) years.add(pg.startYear); });
  const sel = document.getElementById('org-chart-year');
  const ys = [...years];
  let opts = '<option value="">全期間(歴代)</option>';
  if (ys.length) for (let y = Math.min(...ys); y <= Math.max(...ys); y++) opts += `<option value="${y}">${y}年</option>`;
  sel.innerHTML = opts;
  sel.value = orgChartYear;

  // 役職の列は、組織で決めた偉さの順に左から並べる
  const order = orgRoleOrder(name);
  const cols = [...roleCols.values()].map((c) => ({ ...c, items: c.items.sort(byYear) }))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  if (members.length) cols.push({ role: '所属', category: '', items: members.sort(byYear), isMembers: true });

  const W = 104, H = 46, GAP_X = 18, GAP_Y = 22;
  const orgY = 20, headY = 110, itemY0 = 186;
  const totalW = Math.max(cols.length, 1) * W + Math.max(0, cols.length - 1) * GAP_X;
  const width = Math.max(totalW + 40, 320);
  const maxItems = Math.max(1, ...cols.map((c) => c.items.length));
  const height = itemY0 + maxItems * (H + GAP_Y) + 10;
  const RATIO = 0.8;
  const svg = document.getElementById('org-chart-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = (width * RATIO) + 'px';
  svg.style.height = (height * RATIO) + 'px';
  svg.innerHTML = '';
  const LINE = '#b9b0d6';
  const line = (x1, y1, x2, y2) => svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: LINE, 'stroke-width': 2 }));
  const box = (x, y, title, sub, opt) => {
    const g = svgEl('g', opt.personId != null ? { 'data-chart-person': opt.personId, style: 'cursor:pointer' } : {});
    g.appendChild(svgEl('rect', { x, y, width: W, height: H, rx: 8, fill: opt.fill, stroke: opt.stroke, 'stroke-width': 1.5 }));
    const t = svgEl('text', { x: x + W / 2, y: y + (sub ? 19 : 28), 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: opt.color });
    t.textContent = title.length > 7 ? title.slice(0, 7) + '…' : title;
    g.appendChild(t);
    if (sub) {
      const s = svgEl('text', { x: x + W / 2, y: y + 35, 'text-anchor': 'middle', 'font-size': 9, fill: opt.subColor });
      s.textContent = sub;
      g.appendChild(s);
    }
    svg.appendChild(g);
  };

  const orgX = width / 2 - W / 2;
  const x0 = (width - totalW) / 2;
  if (cols.length) {
    // 組織 → 各役職の列への線(家系図の親→子と同じく、横一本の線から各列へ下ろす)
    const busY = (orgY + H + headY) / 2;
    line(width / 2, orgY + H, width / 2, busY);
    const colX = (i) => x0 + i * (W + GAP_X);
    line(colX(0) + W / 2, busY, colX(cols.length - 1) + W / 2, busY);
    cols.forEach((c, i) => {
      const cx = colX(i) + W / 2;
      line(cx, busY, cx, headY);
      box(colX(i), headY, c.role, c.category || (c.isMembers ? `${c.items.length}人` : ''), { fill: '#ffffff', stroke: '#5b37b7', color: '#5b37b7', subColor: '#8a84a0' });
      // 歴代は上から就任順に縦につなぐ
      c.items.forEach((it, k) => {
        const y = itemY0 + k * (H + GAP_Y);
        line(cx, k === 0 ? headY + H : y - GAP_Y, cx, y);
        box(colX(i), y, it.person.name, formatRolePeriod(it, it.person), { personId: it.person.id, fill: '#ece8f6', stroke: '#d8d0ef', color: '#1c1530', subColor: '#8a84a0' });
      });
    });
  }
  // 組織の箱には、その時点(全期間なら最新)の爵位を添える
  box(orgX, orgY, name || '', peerageAt(name, year), { fill: '#5b37b7', stroke: '#5b37b7', color: '#ffffff', subColor: 'rgba(255,255,255,0.85)' });
  if (!cols.length) {
    const t = svgEl('text', { x: width / 2, y: headY + 20, 'text-anchor': 'middle', 'font-size': 12, fill: '#8a84a0' });
    t.textContent = year != null ? `${year}年の時点で所属・役職のある人物はいません` : '所属・役職のある人物はいません';
    svg.appendChild(t);
  }
}

// 組織名・開始年・終了年がまったく同じ所属は1件にまとめる(同じ人を組織の追加画面で2回選んだ時などの重複を防ぐ)
function dedupeAffiliations(list) {
  const seen = new Set();
  return (list || []).filter((a) => {
    const key = `${a.affiliation}|${a.startYear ?? ''}|${a.endYear ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== 組織一覧(人物を横断して、所属名ごとにグループ表示) =====
function renderOrganizations() {
  const q = (document.getElementById('organizations-search-input').value || '').trim().toLowerCase();
  const groups = new Map();
  // 同じ人物が同じ組織に何度か所属していても(出戻り等)1行にまとめ、期間を「、」で並べる
  people.forEach((p) => dedupeAffiliations(p.affiliations).forEach((a) => {
    if (!a.affiliation) return;
    if (!groups.has(a.affiliation)) groups.set(a.affiliation, []);
    const list = groups.get(a.affiliation);
    const row = list.find((r) => r.person.id === p.id);
    if (row) row.periods.push(a);
    else list.push({ person: p, startYear: a.startYear, endYear: a.endYear, periods: [a] });
  }));
  // 組織内の役職(人物の役職のうち、organizationにこの組織名が入っているもの)
  const orgRoles = new Map();
  people.forEach((p) => (p.roles || []).forEach((r) => {
    if (!r.role || !r.organization) return;
    if (!groups.has(r.organization)) groups.set(r.organization, []);
    if (!orgRoles.has(r.organization)) orgRoles.set(r.organization, []);
    orgRoles.get(r.organization).push({ person: p, role: r.role, category: r.category || '', startYear: r.startYear, endYear: r.endYear });
  }));
  // まだメンバーのいない組織でも、爵位などを登録してあれば一覧に出す
  organizations.forEach((o) => { if (!groups.has(o.name)) groups.set(o.name, []); });
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
  const byYear = (a, b) => (a.startYear ?? 0) - (b.startYear ?? 0);
  listEl.innerHTML = names.map((name) => {
    // 同じ人物は1行にまとめ(役職が複数あっても、所属と役職の両方があっても1回だけ)、その組織での役職と期間を並べる。
    // 並びは組織で決めた役職の偉さの順(一番偉い役職で比べる)→ 同じなら就任の早い順。役職のない人は最後
    const byPerson = new Map();
    const entryOf = (p) => {
      if (!byPerson.has(p.id)) byPerson.set(p.id, { person: p, roles: [], periods: [] });
      return byPerson.get(p.id);
    };
    groups.get(name).forEach((row) => { entryOf(row.person).periods.push(...row.periods); });
    (orgRoles.get(name) || []).forEach((r) => entryOf(r.person).roles.push(r));
    const order = orgRoleOrder(name);
    const rankRole = (role) => { const i = order.indexOf(role); return i < 0 ? 9999 : i; };
    const rankOf = (e) => (e.roles.length ? Math.min(...e.roles.map((r) => rankRole(r.role))) : Infinity);
    const firstYear = (e) => Math.min(...[...e.roles, ...e.periods].map((x) => x.startYear ?? 0));
    const entries = [...byPerson.values()].sort((a, b) => (rankOf(a) - rankOf(b)) || (firstYear(a) - firstYear(b)));
    const rowsHtml = entries.map((e) => {
      const roleText = e.roles.slice().sort((a, b) => (rankRole(a.role) - rankRole(b.role)) || byYear(a, b))
        .map((r) => `${r.role}(${formatRolePeriod(r, e.person)})`).join('、');
      const periodText = e.periods.length ? `所属 ${e.periods.slice().sort(byYear).map((a) => formatRolePeriod(a, e.person)).join('、')}` : '';
      return `<li class="list-item list-item-indent" data-person-id="${e.person.id}">
        <div class="list-item-main">
          <div class="list-item-title">${personNameWithBirthHtml(e.person)}</div>
          <div class="list-item-sub">${escapeHtml([roleText, periodText].filter(Boolean).join(' ・ '))}</div>
        </div>
        <span class="list-item-chevron">›</span>
      </li>`;
    }).join('');
    const peerage = formatPeerageHistory(name);
    return `<li class="list-group-header org-header"><span>${escapeHtml(name)}(${entries.length}人)${peerage ? `<span class="org-peerage">${escapeHtml(peerage)}</span>` : ''}</span><span class="org-header-links"><span class="org-edit-link" data-org-chart="${escapeHtml(name)}">組織図</span><span class="org-edit-link" data-org-name="${escapeHtml(name)}">編集 ›</span></span></li>${rowsHtml}`;
  }).join('');
}

// 組織の役職の偉さの順(偉い順)。組織に保存した並び順を優先し、そこに無い役職は就任の早い順で後ろに足す
function orgRoleOrder(name) {
  const org = organizations.find((o) => o.name === name);
  const order = ((org && org.roleOrder) || []).slice();
  const firstStart = new Map();
  people.forEach((p) => (p.roles || []).forEach((r) => {
    if (r.organization !== name || !r.role) return;
    const y = r.startYear ?? 0;
    if (!firstStart.has(r.role) || y < firstStart.get(r.role)) firstStart.set(r.role, y);
  }));
  [...firstStart.keys()].filter((r) => !order.includes(r))
    .sort((a, b) => firstStart.get(a) - firstStart.get(b)).forEach((r) => order.push(r));
  return order;
}

// ===== 組織の一括追加: 1つの組織を、複数人物にまとめて付与する =====
let bulkAffiliationCheckedIds = new Set();
// 組織一覧で組織名をタップした時は、同じ画面を「組織を編集」として開く(null=新しく追加)
let editingOrgName = null;
let pendingOrgEditName = null;
function openOrgEditor(name) { pendingOrgEditName = name; navigateTo('view-bulk-affiliation'); }
function openBulkAffiliationForm() {
  editingOrgName = pendingOrgEditName;
  pendingOrgEditName = null;
  const editing = editingOrgName != null;
  document.getElementById('bulk-affiliation-title').textContent = editing ? '組織を編集' : '組織を追加';
  document.getElementById('bulk-affiliation-name').value = editing ? editingOrgName : '';
  document.getElementById('bulk-affiliation-start').value = '';
  document.getElementById('bulk-affiliation-end').value = '';
  document.getElementById('bulk-affiliation-person-search').value = '';
  document.getElementById('bulk-affiliation-pick-label').textContent = editing ? '新しく所属させる人物を選ぶ' : '所属する人物を選ぶ';
  document.getElementById('bulk-org-members-section').classList.toggle('hidden', !editing);
  document.getElementById('bulk-org-delete-btn').classList.toggle('hidden', !editing);
  bulkAffiliationCheckedIds = new Set();
  bulkOrgRoleRows = [];
  bulkOrgMemberRows = [];
  bulkOrgPeerageRows = editing
    ? peeragesOf(editingOrgName).map((pg) => ({ rowId: 'orgpeerage' + (bulkOrgPeerageSeq++), startYear: pg.startYear ?? null, title: pg.title }))
    : [];
  renderBulkOrgPeerageList();
  if (editing) {
    people.forEach((p) => {
      (p.roles || []).filter((r) => r.organization === editingOrgName).forEach((r) => bulkOrgRoleRows.push({
        rowId: 'orgrole' + (bulkOrgRoleSeq++), startYear: r.startYear ?? null, endYear: r.endYear ?? null, role: r.role, category: r.category || '', personId: p.id,
      }));
      dedupeAffiliations(p.affiliations).filter((a) => a.affiliation === editingOrgName).forEach((a) => bulkOrgMemberRows.push({
        rowId: 'orgmember' + (bulkOrgMemberSeq++), personId: p.id, startYear: a.startYear ?? null, endYear: a.endYear ?? null,
      }));
    });
    const byYear = (a, b) => (a.startYear ?? 0) - (b.startYear ?? 0);
    bulkOrgRoleOrder = orgRoleOrder(editingOrgName);
    bulkOrgRoleRows.sort((a, b) => (bulkOrgRoleOrder.indexOf(a.role) - bulkOrgRoleOrder.indexOf(b.role)) || byYear(a, b));
    bulkOrgMemberRows.sort(byYear);
  } else {
    bulkOrgRoleOrder = [];
  }
  document.getElementById('bulk-org-role-order-name').value = '';
  renderBulkOrgRoleOrder();
  renderBulkOrgRoleList();
  renderBulkOrgMemberList();
  renderBulkAffiliationPersonList();
}

// 組織の爵位(年代ごと): {rowId, startYear, title}。授かった年・陞爵した年ごとに1行
let bulkOrgPeerageRows = [];
let bulkOrgPeerageSeq = 0;
function renderBulkOrgPeerageList() {
  document.getElementById('bulk-org-peerage-list').innerHTML = bulkOrgPeerageRows.map((row) => `<li class="participant-row summary-row org-peerage-row" data-row-id="${row.rowId}">
      <input class="og-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="年">
      <input class="og-title" type="text" list="peerage-datalist" value="${escapeHtml(row.title || '')}" placeholder="爵位(例: 伯爵)">
      <button type="button" class="remove-btn" data-remove-org-peerage="${row.rowId}">×</button>
    </li>`).join('');
}

// 組織を編集する時の、今の所属メンバー(人物ごと・期間ごとに1行。期間の修正と外すことができる)
let bulkOrgMemberRows = [];
let bulkOrgMemberSeq = 0;
function renderBulkOrgMemberList() {
  const listEl = document.getElementById('bulk-org-member-list');
  listEl.innerHTML = bulkOrgMemberRows.map((row) => {
    const person = personById(row.personId);
    return `<li class="participant-row summary-row org-member-row" data-row-id="${row.rowId}">
      <input class="om-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
      <input class="om-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
      <div class="list-item-main">${person ? personNameWithBirthHtml(person) : '?'}</div>
      <button type="button" class="remove-btn" data-remove-org-member="${row.rowId}">×</button>
    </li>`;
  }).join('');
  document.getElementById('bulk-org-member-empty').classList.toggle('hidden', bulkOrgMemberRows.length > 0);
}

// 同名・似た名前の人物を見分けやすいように、名前の横に生年を小さく添える(生年未設定なら名前だけ)
function personNameWithBirthHtml(p) {
  return `${escapeHtml(p.name)}${p.birthYear != null ? ` <span class="name-birth">${p.birthYear}年生</span>` : ''}`;
}

// 組織の役職の偉さの順(上ほど偉い)。組織図では左から、組織一覧では上からこの順に並ぶ
let bulkOrgRoleOrder = [];
function renderBulkOrgRoleOrder() {
  const n = bulkOrgRoleOrder.length;
  document.getElementById('bulk-org-role-order-list').innerHTML = bulkOrgRoleOrder.map((role, i) => `<li class="participant-row org-order-row">
      <span class="org-order-num">${i + 1}</span>
      <div class="list-item-main">${escapeHtml(role)}</div>
      <button type="button" class="order-btn" data-order-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="order-btn" data-order-down="${i}" ${i === n - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="remove-btn" data-order-remove="${i}">×</button>
    </li>`).join('');
}

// 組織内の役職(年代ごと): {rowId, startYear, endYear, role, category, personId}
let bulkOrgRoleRows = [];
let bulkOrgRoleSeq = 0;
function renderBulkOrgRoleList() {
  document.getElementById('bulk-org-role-list').innerHTML = bulkOrgRoleRows.map((row) => {
    const person = row.personId != null ? personById(row.personId) : null;
    // 役職は上の「役職の順番」に登録したものから、偉い順に並んだ選択肢で選ぶ
    const roleOptions = `<option value="">役職を選ぶ-</option>` + bulkOrgRoleOrder
      .map((r, i) => `<option value="${escapeHtml(r)}" ${r === row.role ? 'selected' : ''}>${i + 1}. ${escapeHtml(r)}</option>`).join('');
    return `<li class="participant-row-wrap summary-row org-role-row" data-row-id="${row.rowId}">
      <div class="participant-row-top">
        <input class="ob-start" type="number" min="0" max="3000" value="${row.startYear ?? ''}" placeholder="開始">
        <input class="ob-end" type="number" min="0" max="3000" value="${row.endYear ?? ''}" placeholder="終了">
        <select class="ob-name ob-role-select">${roleOptions}</select>
        <select class="ob-category">${roleCategoryOptionsHtml(row.category)}</select>
        <button type="button" class="remove-btn" data-remove-org-role="${row.rowId}">×</button>
      </div>
      <div class="participant-row-bottom">
        <button type="button" class="picker-btn ob-person${person ? '' : ' is-placeholder'}">${person ? personNameWithBirthHtml(person) : '就いた人物を選ぶ'}</button>
      </div>
    </li>`;
  }).join('');
}
function renderBulkAffiliationPersonList() {
  const q = (document.getElementById('bulk-affiliation-person-search').value || '').trim().toLowerCase();
  const listEl = document.getElementById('bulk-affiliation-person-list');
  const filtered = q ? people.filter((p) => (p.name || '').toLowerCase().includes(q)) : people;
  const sorted = filtered.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  listEl.innerHTML = sorted.map((p) => `<li class="list-item list-item-check" data-person-id="${p.id}">
      <input type="checkbox" class="bulk-affiliation-check" data-person-id="${p.id}" ${bulkAffiliationCheckedIds.has(p.id) ? 'checked' : ''}>
      <div class="list-item-main"><div class="list-item-title">${personNameWithBirthHtml(p)}</div></div>
    </li>`).join('');
}

// ===== 出来事フォーム: 参加者編集 =====
function renderEventFormParticipants() {
  const pm = peopleMapCache();
  // 他の出来事や人物自身に設定済みの陣営名を候補に出す(表記ゆれ防止)
  const factionNames = new Set();
  events.forEach((ev) => (ev.participants || []).forEach((p) => { if (p.faction) factionNames.add(p.faction); }));
  people.forEach((person) => (person.factions || []).forEach((f) => { if (f.faction) factionNames.add(f.faction); }));
  document.getElementById('event-faction-datalist').innerHTML =
    Array.from(factionNames).map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
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
        <input class="pf-faction" type="text" placeholder="陣営(例: 東軍)" value="${escapeHtml(p.faction || '')}" list="event-faction-datalist">
      </div>
      <div class="participant-row-bottom">
        <select class="pf-tier"><option value="">ティア-</option>${strengthTierOptionsHtml(p.tier)}</select>
        <input class="pf-score" type="number" min="0" max="100" placeholder="点数(任意)" value="${p.score ?? ''}">
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
  document.getElementById('event-form-add-person').value = '';
  updatePersonPickerButtonLabel('event-form-add-person', 'event-form-add-person-picker', '選択してください');
}

// ===== 地形配置キャンバス =====
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// 山はタップで置く元の方式に戻す(標高1〜3が高いほど大きく・色が濃くなる台形)
const HILL_ELEVATIONS = [1, 2, 3];
const HILL_COLORS = { 1: '#aebb8f', 2: '#8a9a6b', 3: '#64744a' };
function hillPoints(cx, cy, elevation) {
  const scale = 0.7 + (elevation || 2) * 0.3; // 1→1.0倍, 2→1.3倍, 3→1.6倍
  return [[cx - 20 * scale, cy + 12 * scale], [cx - 9 * scale, cy - 14 * scale], [cx + 9 * scale, cy - 14 * scale], [cx + 20 * scale, cy + 12 * scale]];
}
// なぞって描いていた旧データ(points配列)が残っていても表示だけは崩れないようにするフォールバック
function hillOutlinePoints(shape) {
  if (shape.points) return shape.points;
  return hillPoints(shape.x, shape.y, shape.elevation || 2).map(([x, y]) => ({ x, y }));
}

// 川はペンで書いたような滑らかな曲線にするため、なぞった点の配列(points)として持つ。
// 旧データ(2点のみ/中心点のみ)は読み込み時にpoints配列へ変換してフォールバックする
function riverPointsOf(shape) {
  if (shape.points) return shape.points;
  if (shape.x1 != null) return [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
  return [{ x: shape.x - 30, y: shape.y }, { x: shape.x + 30, y: shape.y }];
}

// 点の配列を、各点の中間点を通る2次ベジェで繋いで滑らかな開いた線にする(川に使う。ペン描画の簡易スムージング)
function smoothPathD(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q${points[i].x},${points[i].y} ${midX},${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

// 城は地図記号(城跡記号)のように、凹凸のある城壁(クレネレーション)のシルエットで表す
function castlePoints(cx, cy) {
  const w = 26, h = 24;
  const left = cx - w / 2, right = cx + w / 2;
  const bottom = cy + h / 2, topGap = cy - h / 2 + 7, topTooth = cy - h / 2;
  const t = w / 5; // 歯3つ+隙間2つで5分割
  return [
    [left, bottom], [left, topGap], [left, topTooth], [left + t, topTooth], [left + t, topGap],
    [left + t * 2, topGap], [left + t * 2, topTooth], [left + t * 3, topTooth], [left + t * 3, topGap],
    [left + t * 4, topGap], [left + t * 4, topTooth], [right, topTooth], [right, topGap], [right, bottom],
  ];
}

// 陣営名ごとに色を固定して割り当てる(簡易ハッシュ。同じ陣営は常に同じ色になる)。陣営未設定は既定色
const FACTION_PALETTE = ['#5b37b7', '#c0392b', '#1f8a5f', '#c98a1a', '#2f6fb0', '#9b4fc9', '#4a4a4a', '#b5456b'];
function factionColorOf(faction) {
  if (!faction) return '#5b37b7';
  let hash = 0;
  for (let i = 0; i < faction.length; i++) hash = (hash * 31 + faction.charCodeAt(i)) >>> 0;
  return FACTION_PALETTE[hash % FACTION_PALETTE.length];
}

// 布陣図の下に、登場している陣営と色の対応を示す凡例を出す(陣営未設定の参加者しかいない時は何も出ない)
function renderMapLegend(elId, participants) {
  const el = document.getElementById(elId);
  if (!el) return;
  const factions = [...new Set(participants.filter((p) => p.position && (p.faction || '').trim()).map((p) => p.faction.trim()))];
  el.innerHTML = factions.map((f) => `<span class="map-legend-item"><span class="map-legend-dot" style="background:${factionColorOf(f)}"></span>${escapeHtml(f)}</span>`).join('');
}

function renderMapSvg(svg, shapes, participants, pm) {
  svg.innerHTML = '';
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: 400, height: 300, fill: '#dfe8d8' }));
  shapes.forEach((shape, idx) => {
    if (shape.type === 'hill') {
      const elevation = shape.elevation || 2;
      const pts = hillOutlinePoints(shape).map((p) => `${p.x},${p.y}`).join(' ');
      svg.appendChild(svgEl('polygon', { points: pts, fill: HILL_COLORS[elevation] || HILL_COLORS[2], stroke: '#5f6f45', 'stroke-width': 1.5, 'data-kind': 'shape', 'data-shape-idx': idx }));
    } else if (shape.type === 'river') {
      const d = smoothPathD(riverPointsOf(shape));
      if (d) svg.appendChild(svgEl('path', { d, fill: 'none', stroke: '#5b8bd0', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-kind': 'shape', 'data-shape-idx': idx }));
    } else if (shape.type === 'castle') {
      const g = svgEl('g', { 'data-kind': 'shape', 'data-shape-idx': idx });
      const pts = castlePoints(shape.x, shape.y).map((p) => p.join(',')).join(' ');
      g.appendChild(svgEl('polygon', { points: pts, fill: '#a9896a', stroke: '#5f4a32', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
      const label = svgEl('text', { x: shape.x, y: shape.y + 24, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#1c1530' });
      label.textContent = shape.name || '城';
      g.appendChild(label);
      svg.appendChild(g);
    }
  });
  // 布陣図らしく、参加者の色は陣営ごとに固定(死亡は輪を赤くして区別する。陣営未設定は既定色1色にまとまる)
  participants.forEach((p, idx) => {
    if (!p.position) return;
    const person = pm.get(p.personId);
    const name = person ? person.name : '?';
    const dead = p.status === '死亡';
    const g = svgEl('g', { 'data-kind': 'marker', 'data-participant-idx': idx });
    g.appendChild(svgEl('circle', { cx: p.position.x, cy: p.position.y, r: 14, fill: factionColorOf(p.faction), stroke: dead ? '#d1374a' : '#fff', 'stroke-width': dead ? 3 : 2 }));
    const text = svgEl('text', { x: p.position.x, y: p.position.y + 26, 'text-anchor': 'middle', 'font-size': 11, fill: '#1c1530' });
    text.textContent = name.slice(0, 6);
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
  renderMapSvg(svg, mapDraftShapes, mapDraftParticipants, peopleMapCache());
  renderMapLegend('map-legend', mapDraftParticipants);
}

function renderMapToolbar() {
  const bar = document.getElementById('map-toolbar');
  const tools = [
    { id: 'hill', label: '⛰ 山を置く' },
    { id: 'river', label: '🌊 川を描く' },
    { id: 'castle', label: '🏯 城を置く' },
    { id: 'edit', label: '✏️ 高さ・名前を変更' },
    { id: 'delete', label: '🗑 地形を削除' },
  ];
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

async function editMapShape(idx) {
  const shape = mapDraftShapes[idx];
  if (!shape) return;
  if (shape.type === 'hill') {
    // タップするたびに標高(大きさ・色の濃さ)を1→2→3→1と切り替える
    const i = HILL_ELEVATIONS.indexOf(shape.elevation || 2);
    shape.elevation = HILL_ELEVATIONS[(i + 1) % HILL_ELEVATIONS.length];
    redrawMapEditor();
  } else if (shape.type === 'castle') {
    const name = await promptText('城の名前', shape.name || '城');
    if (name == null) return;
    shape.name = name.trim() || '城';
    redrawMapEditor();
  }
}

const DRAW_SAMPLE_DIST = 6; // なぞって描く時、前の点からこの距離(SVG座標)以上動いたら新しい点を追加する
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
    if (g && selectedMapTool === 'edit') {
      if (g.dataset.kind === 'shape') editMapShape(Number(g.dataset.shapeIdx));
      return;
    }
    if (g) {
      if (g.dataset.kind === 'shape') {
        // 輪郭(points)を持つ山・川は、その点をすべて一緒にずらせるよう始点からの移動量(dx, dy)を記録しておく
        mapDragging = { kind: 'shape', idx: Number(g.dataset.shapeIdx), startPt: svgPoint(svg, e), orig: { ...mapDraftShapes[Number(g.dataset.shapeIdx)] } };
      } else {
        mapDragging = { kind: 'marker', idx: Number(g.dataset.participantIdx) };
      }
      return;
    }
    if (selectedMapTool === 'hill') {
      // 山は元の方式どおり、タップした場所にその場で既定の台形を置く
      const pt = svgPoint(svg, e);
      mapDraftShapes.push({ type: 'hill', x: pt.x, y: pt.y, elevation: 2 });
      redrawMapEditor();
    } else if (selectedMapTool === 'river') {
      // 川はペンで書くように、タップした点から始めてなぞった軌跡をそのまま滑らかな線にする
      const pt = svgPoint(svg, e);
      const newShape = { type: 'river', points: [pt] };
      mapDraftShapes.push(newShape);
      mapDragging = { kind: 'draw', shape: newShape, lastPt: pt };
      redrawMapEditor();
    } else if (selectedMapTool === 'castle') {
      const pt = svgPoint(svg, e);
      promptText('城の名前', '城').then((name) => {
        if (name == null) return;
        mapDraftShapes.push({ type: 'castle', x: pt.x, y: pt.y, name: name.trim() || '城' });
        redrawMapEditor();
      });
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!mapDragging) return;
    const pt = svgPoint(svg, e);
    if (mapDragging.kind === 'draw') {
      const dx = pt.x - mapDragging.lastPt.x, dy = pt.y - mapDragging.lastPt.y;
      if (Math.hypot(dx, dy) < DRAW_SAMPLE_DIST) return; // なぞり点を間引いて点数を抑える
      mapDragging.shape.points.push(pt);
      mapDragging.lastPt = pt;
    } else if (mapDragging.kind === 'shape') {
      const shape = mapDraftShapes[mapDragging.idx];
      const orig = mapDragging.orig;
      const dx = pt.x - mapDragging.startPt.x;
      const dy = pt.y - mapDragging.startPt.y;
      if (orig.points) shape.points = orig.points.map((o) => ({ x: o.x + dx, y: o.y + dy }));
      else { shape.x = orig.x + dx; shape.y = orig.y + dy; }
    } else {
      mapDraftParticipants[mapDragging.idx].position = { x: pt.x, y: pt.y };
    }
    redrawMapEditor();
  });
  window.addEventListener('pointerup', () => {
    // 川をなぞらずタップだけで終えた(点が1つしかない)場合は、線にならないので取り消す
    if (mapDragging && mapDragging.kind === 'draw' && mapDragging.shape.points.length < 2) {
      mapDraftShapes = mapDraftShapes.filter((s) => s !== mapDragging.shape);
      redrawMapEditor();
    }
    mapDragging = null;
  });
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

// ===== 名前入力シート =====
// iOSのホーム画面PWA(standalone)ではwindow.prompt()のテキスト欄にキーボードが出ないことがあるため、
// 自前のシートで代替する。window.prompt()と同じ感覚で使えるようPromiseで名前(キャンセル時はnull)を返す
let pendingPromptResolve = null;
function promptText(label, defaultValue) {
  return new Promise((resolve) => {
    pendingPromptResolve = resolve;
    document.getElementById('prompt-sheet-label').textContent = label;
    const input = document.getElementById('prompt-sheet-input');
    input.value = defaultValue || '';
    document.getElementById('prompt-sheet').classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
  });
}
function resolvePromptSheet(value) {
  const resolve = pendingPromptResolve;
  pendingPromptResolve = null;
  document.getElementById('prompt-sheet').classList.add('hidden');
  if (resolve) resolve(value);
}

// ===== 人物選択シート =====
// 人数が増えるとプルダウンでは選びにくいため、検索付きのシートで人物を選ぶ(プルダウンの代わりに使う共通部品)。
// resolveする値: { type: 'existing', id } | { type: 'new' } | { type: 'clear' } | null(キャンセル)
let personPickerResolve = null;
let personPickerExcludeIds = [];
function openPersonPicker(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    personPickerResolve = resolve;
    personPickerExcludeIds = opts.excludeIds || [];
    document.getElementById('person-picker-clear').classList.toggle('hidden', !opts.allowClear);
    document.getElementById('person-picker-search').value = '';
    renderPersonPickerList('');
    document.getElementById('person-picker-sheet').classList.remove('hidden');
    setTimeout(() => document.getElementById('person-picker-search').focus(), 50);
  });
}
function renderPersonPickerList(query) {
  const q = (query || '').trim();
  const exclude = new Set(personPickerExcludeIds);
  const list = people
    .filter((p) => !exclude.has(p.id))
    .filter((p) => !q || [p.name, p.kana, p.youmei, p.maidenName].filter(Boolean).some((s) => s.includes(q)))
    .slice().sort((a, b) => (a.kana || a.name || '').localeCompare(b.kana || b.name || '', 'ja'));
  document.getElementById('person-picker-list').innerHTML = list.length
    ? list.map((p) => `<button type="button" class="sheet-btn" data-picker-person="${p.id}">${personNameWithBirthHtml(p)}</button>`).join('')
    : '<div class="person-picker-empty">該当する人物がいません</div>';
}
function closePersonPicker(result) {
  const resolve = personPickerResolve;
  personPickerResolve = null;
  document.getElementById('person-picker-sheet').classList.add('hidden');
  if (resolve) resolve(result);
}

// プルダウンの代わりに人物選択シートを開くボタンを設定する。対象のinput[type=hidden]のvalueに
// 選択結果(数値ID文字列/NEW_PERSON_OPTION/空文字)を反映するので、既存のresolvePersonFromSelect等はそのまま使える
function wirePersonPickerButton(hiddenId, btnId, opts) {
  opts = opts || {};
  document.getElementById(btnId).addEventListener('click', async () => {
    const result = await openPersonPicker({
      excludeIds: opts.getExcludeIds ? opts.getExcludeIds() : [],
      allowClear: opts.allowClear,
    });
    if (!result) return;
    const value = result.type === 'clear' ? '' : result.type === 'new' ? NEW_PERSON_OPTION : String(result.id);
    document.getElementById(hiddenId).value = value;
    updatePersonPickerButtonLabel(hiddenId, btnId, opts.placeholder);
    if (opts.onChange) await opts.onChange(value);
  });
}
function updatePersonPickerButtonLabel(hiddenId, btnId, placeholder) {
  const val = document.getElementById(hiddenId).value;
  const btn = document.getElementById(btnId);
  if (val === NEW_PERSON_OPTION) { btn.textContent = '+ 新しい人物を作成...'; btn.classList.remove('is-placeholder'); return; }
  const p = val ? personById(Number(val)) : null;
  btn.textContent = p ? p.name : placeholder;
  btn.classList.toggle('is-placeholder', !p);
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
  const episode = document.getElementById('person-form-episode').value.trim();
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
      category: r.category || '',
      startYear: r.startYear != null && r.startYear !== '' ? clampYear(r.startYear) : null,
      endYear: r.endYear != null && r.endYear !== '' ? clampYear(r.endYear) : null,
      ...((r.organization || '').trim() ? { organization: r.organization.trim() } : {}),
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  const affiliations = affiliationDraftRows
    .filter((a) => (a.affiliation || '').trim())
    .map((a) => ({
      affiliation: a.affiliation.trim(),
      startYear: a.startYear != null && a.startYear !== '' ? clampYear(a.startYear) : null,
      endYear: a.endYear != null && a.endYear !== '' ? clampYear(a.endYear) : null,
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  const affiliationsUnique = dedupeAffiliations(affiliations);
  const qualifications = qualificationDraftRows
    .filter((q) => (q.qualification || '').trim())
    .map((q) => ({
      qualification: q.qualification.trim(),
      startYear: q.startYear != null && q.startYear !== '' ? clampYear(q.startYear) : null,
      endYear: q.endYear != null && q.endYear !== '' ? clampYear(q.endYear) : null,
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  const medals = medalDraftRows
    .filter((m) => (m.medal || '').trim())
    .map((m) => ({
      medal: m.medal.trim(),
      rank: (m.rank || '').trim(),
      startYear: m.startYear != null && m.startYear !== '' ? clampYear(m.startYear) : null,
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  // 陣営が変わっても矢印(→)で推移を表せるよう、所属年の昇順に並べ替えてから保存する
  const factions = factionDraftRows
    .filter((f) => (f.faction || '').trim())
    .map((f) => ({
      faction: f.faction.trim(),
      startYear: f.startYear != null && f.startYear !== '' ? clampYear(f.startYear) : null,
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  // 強さも陣営と同じく、成長の推移を矢印で表せるよう年代の昇順に並べ替えてから保存する
  const strength = strengthDraftRows
    .filter((s) => s.tier)
    .map((s) => ({
      tier: s.tier,
      score: s.score != null && s.score !== '' ? Number(s.score) : null,
      startYear: s.startYear != null && s.startYear !== '' ? clampYear(s.startYear) : null,
    }))
    .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  const abilities = abilityDraftRows
    .filter((a) => (a.ability || '').trim())
    .map((a) => ({ ability: a.ability.trim() }));
  const weapons = weaponDraftRows
    .filter((w) => (w.weapon || '').trim())
    .map((w) => ({ weapon: w.weapon.trim() }));
  const skills = skillDraftRows
    .filter((s) => (s.skill || '').trim())
    .map((s) => ({ skill: s.skill.trim(), description: (s.description || '').trim() }));
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
    p.name = name; p.kana = kana; p.youmei = youmei; p.maidenName = maidenName; p.episode = episode; p.genpukuYear = genpukuYear; p.genpukuMonth = genpukuMonth;
    p.roles = roles; p.affiliations = affiliationsUnique; p.qualifications = qualifications; p.medals = medals; p.factions = factions;
    p.strength = strength;
    p.abilities = abilities; p.weapons = weapons; p.skills = skills; p.relationships = relationships;
    p.birthYear = birthYear; p.deathYear = deathYear;
    p.fatherId = fatherId; p.motherId = motherId; p.spouseIds = spouseIds;
    await DB.updatePerson(p);
  } else {
    personId = await DB.addPerson({
      name, kana, youmei, maidenName, episode, genpukuYear, genpukuMonth, roles, affiliations: affiliationsUnique, qualifications, medals, factions, strength,
      abilities, weapons, skills, relationships, birthYear, deathYear, fatherId, motherId, spouseIds, createdAt: Date.now(),
    });
    currentPersonId = personId;
  }
  await syncSpouseLinks(personId, oldSpouseIds, spouseIds);
  for (const newSpouseId of spouseIds.filter((sid) => !oldSpouseIds.includes(sid))) {
    await autoLinkSpouseToChildren(personId, newSpouseId);
    await autoLinkSpouseToChildren(newSpouseId, personId);
  }
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

// 既に子がいる人物に新しく配偶者を追加した時、その子の「もう片方の親」が空欄ならその配偶者を自動的に設定する
// (実子・養子どちらも対象。既に別の親が入っている場合は上書きしない)
async function autoLinkSpouseToChildren(personId, spouseId) {
  if (personId == null || spouseId == null) return;
  for (const child of people.filter((c) => c.fatherId === personId || c.motherId === personId)) {
    if (child.fatherId === personId && child.motherId == null) { child.motherId = spouseId; await DB.updatePerson(child); }
    else if (child.motherId === personId && child.fatherId == null) { child.fatherId = spouseId; await DB.updatePerson(child); }
  }
  for (const child of people.filter((c) => c.adoptiveFatherId === personId || c.adoptiveMotherId === personId)) {
    if (child.adoptiveFatherId === personId && child.adoptiveMotherId == null) { child.adoptiveMotherId = spouseId; await DB.updatePerson(child); }
    else if (child.adoptiveMotherId === personId && child.adoptiveFatherId == null) { child.adoptiveFatherId = spouseId; await DB.updatePerson(child); }
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
  for (const ev of events.filter((e) => (e.participants || []).some((p) => p.personId === id || killedIdsOf(p).includes(id) || injuredIdsOf(p).includes(id)))) {
    ev.participants = ev.participants.filter((p) => p.personId !== id);
    // 消した人物を「討ち取った/負傷させた相手」に入れている参加者からも外す
    ev.participants.forEach((p) => {
      p.killedPersonIds = killedIdsOf(p).filter((x) => x !== id);
      p.injuredPersonIds = injuredIdsOf(p).filter((x) => x !== id);
    });
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

// 出来事の参加者に設定した陣営を、人物側の陣営履歴(factions)にも自動反映する。
// 「その年にその陣営」という組み合わせがまだ無い時だけ追加する(同じ出来事を何度保存しても重複登録されない)
async function syncFactionsFromParticipants(ev) {
  for (const part of ev.participants || []) {
    const faction = (part.faction || '').trim();
    if (!faction) continue;
    const person = personById(part.personId);
    if (!person) continue;
    const list = person.factions || [];
    if (list.some((f) => f.faction === faction && f.startYear === ev.year)) continue;
    person.factions = [...list, { faction, startYear: ev.year }].sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
    await DB.updatePerson(person);
  }
}

// 出来事で付けたティアを、人物の強さの履歴(strength)にその年の値として反映する。
// 同じ年の記録があれば上書き(戦いのティアを直したら人物側も直る)、無ければ追加する
async function syncStrengthFromParticipants(ev) {
  for (const part of ev.participants || []) {
    if (!part.tier) continue;
    const person = personById(part.personId);
    if (!person) continue;
    const score = part.score != null && part.score !== '' ? Number(part.score) : null;
    const list = (person.strength || []).slice();
    const same = list.find((s) => s.startYear === ev.year);
    if (same) {
      if (same.tier === part.tier && (same.score ?? null) === score) continue;
      same.tier = part.tier;
      same.score = score;
    } else {
      list.push({ tier: part.tier, score, startYear: ev.year });
    }
    person.strength = list.sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
    await DB.updatePerson(person);
  }
}

// 出来事の年を変えた・参加者の生死やティアを変えた・参加者を外した・出来事を消した時に、
// 前の内容から人物側へ自動で入れた値(没年・陣営・強さ)が古いまま残らないように取り消す。
// 取り消すのは「前の出来事の年・値と完全に一致し、ほかの出来事からは同じ値が出てこない」ものだけ(手入力した値は極力残す)
async function undoAutoSyncedData(oldEv, newEv) {
  if (!oldEv) return;
  const oldYear = oldEv.year;
  const yearChanged = !newEv || newEv.year !== oldYear;
  const others = events.filter((e) => e.id !== oldEv.id);
  for (const oldPart of oldEv.participants || []) {
    const person = personById(oldPart.personId);
    if (!person) continue;
    const newPart = newEv ? (newEv.participants || []).find((p) => p.personId === oldPart.personId) : null;
    const otherParts = others.filter((e) => e.year === oldYear)
      .map((e) => (e.participants || []).find((p) => p.personId === person.id)).filter(Boolean);
    let changed = false;
    if (oldPart.status === '死亡' && person.deathYear === oldYear && (yearChanged || !newPart || newPart.status !== '死亡')
      && !otherParts.some((p) => p.status === '死亡')) {
      person.deathYear = null; changed = true;
    }
    const oldFaction = (oldPart.faction || '').trim();
    if (oldFaction && (yearChanged || !newPart || (newPart.faction || '').trim() !== oldFaction)
      && !otherParts.some((p) => (p.faction || '').trim() === oldFaction)) {
      const before = (person.factions || []).length;
      person.factions = (person.factions || []).filter((f) => !(f.faction === oldFaction && f.startYear === oldYear));
      if (person.factions.length !== before) changed = true;
    }
    if (oldPart.tier && (yearChanged || !newPart || !newPart.tier) && !otherParts.some((p) => p.tier)) {
      const oldScore = oldPart.score != null && oldPart.score !== '' ? Number(oldPart.score) : null;
      const before = (person.strength || []).length;
      person.strength = (person.strength || []).filter((s) => !(s.startYear === oldYear && s.tier === oldPart.tier && (s.score ?? null) === oldScore));
      if (person.strength.length !== before) changed = true;
    }
    if (changed) await DB.updatePerson(person);
  }
}

// 子出来事の参加者は、親出来事にも自動で参加者として追加する(まだ参加していない人のみ)。
// 既に親出来事にも参加している場合、子出来事で死亡していれば親出来事側も死亡に更新する(回復はさせない)
async function syncParticipantsToParentEvent(ev) {
  if (ev.parentEventId == null) return;
  const parent = eventById(ev.parentEventId);
  if (!parent) return;
  const byId = new Map((parent.participants || []).map((p) => [p.personId, p]));
  let changed = false;
  for (const part of ev.participants || []) {
    const existing = byId.get(part.personId);
    if (existing) {
      if (part.status === '死亡' && existing.status !== '死亡') { existing.status = '死亡'; changed = true; }
    } else {
      byId.set(part.personId, { personId: part.personId, status: part.status, note: '', position: null, killedPersonIds: [], injuredPersonIds: [], faction: part.faction || '' });
      changed = true;
    }
  }
  if (!changed) return;
  parent.participants = Array.from(byId.values());
  await DB.updateEvent(parent);
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
    await undoAutoSyncedData(JSON.parse(JSON.stringify(ev)), { year, participants: draftParticipants });
    ev.title = title; ev.category = category; ev.year = year; ev.month = month; ev.endYear = endYear; ev.endMonth = endMonth;
    ev.description = description; ev.participants = draftParticipants;
    await DB.updateEvent(ev);
    currentEventId = ev.id;
    await syncDeathYearsFromParticipants(ev);
    await syncFactionsFromParticipants(ev);
    await syncStrengthFromParticipants(ev);
    await syncParticipantsToParentEvent(ev);
  } else {
    const id = await DB.addEvent({ title, category, year, month, endYear, endMonth, description, terrainMap: null, participants: draftParticipants, parentEventId: eventFormParentId });
    currentEventId = id;
    await syncDeathYearsFromParticipants({ year, participants: draftParticipants });
    await syncFactionsFromParticipants({ year, participants: draftParticipants });
    await syncStrengthFromParticipants({ year, participants: draftParticipants });
    await syncParticipantsToParentEvent({ parentEventId: eventFormParentId, participants: draftParticipants });
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
  await undoAutoSyncedData(eventById(id), null);
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
  document.getElementById('event-form-category').value = '出来事'; // 前に開いた出来事の分類が残らないように
  document.getElementById('event-form-year').value = '';
  document.getElementById('event-form-month').value = '';
  document.getElementById('event-form-end-year').value = '';
  document.getElementById('event-form-end-month').value = '';
  document.getElementById('event-form-description').value = memo;
  draftParticipants = Array.from(memoDetectedPersonIds).map((pid) => ({ personId: pid, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [], faction: '' }));
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
  // 並び順は「父・母」「養父・養母」のように夫婦の組が隣り合うようにする(父と母の間に養父が挟まると、
  // 父母を結ぶ婚姻線が養父の箱の真裏を通って「養父が両方と結婚している」ように見えてしまうため)
  const parentEntries = [
    father ? { person: father, label: '父', rel: 'father' } : null,
    mother ? { person: mother, label: '母', rel: 'mother' } : null,
    adoptiveFather ? { person: adoptiveFather, label: '養父', rel: 'adoptiveFather' } : null,
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
  // 既存の人物から選ぶか、新しく人物を作るかをシートで選ばせる(既存の人物ともすぐに関係を結べるようにする)
  const result = await openPersonPicker({ excludeIds: [focus.id] });
  if (!result) return;
  let personId;
  if (result.type === 'new') {
    const name = ((await promptText('新しい人物の名前を入力してください')) || '').trim();
    if (!name) return;
    personId = await resolvePersonByName(name, null);
  } else {
    personId = result.id;
  }
  await refreshAll();
  const target = personById(personId);
  if (!target) return;

  if (relation === 'father') {
    focus.fatherId = personId;
    await DB.updatePerson(focus);
    await refreshAll();
    await autoLinkParentsAsSpouses(personId, focus.motherId);
  } else if (relation === 'mother') {
    focus.motherId = personId;
    await DB.updatePerson(focus);
    await refreshAll();
    await autoLinkParentsAsSpouses(focus.fatherId, personId);
  } else if (relation === 'adoptiveFather') {
    focus.adoptiveFatherId = personId;
    await DB.updatePerson(focus);
  } else if (relation === 'adoptiveMother') {
    focus.adoptiveMotherId = personId;
    await DB.updatePerson(focus);
  } else if (relation === 'spouse') {
    if (!(focus.spouseIds || []).includes(personId)) focus.spouseIds = [...(focus.spouseIds || []), personId];
    if (!(target.spouseIds || []).includes(focus.id)) target.spouseIds = [...(target.spouseIds || []), focus.id];
    await DB.updatePerson(focus);
    await DB.updatePerson(target);
    await refreshAll();
    await autoLinkSpouseToChildren(focus.id, personId);
    await autoLinkSpouseToChildren(personId, focus.id);
  } else if (relation === 'sibling') {
    // 本人と同じ父・母を持つ兄弟姉妹として登録する(既に親が設定済みなら上書きしない)
    if (target.fatherId == null) target.fatherId = focus.fatherId ?? null;
    if (target.motherId == null) target.motherId = focus.motherId ?? null;
    await DB.updatePerson(target);
  } else if (relation === 'child') {
    const asFather = confirm(`${focus.name}を「${target.name}」の「父」として登録しますか?\n(OK=父として登録／キャンセル=母として登録)`);
    const isAdopted = confirm('養子として登録しますか?\n(OK=養子として登録／キャンセル=実子として登録)');
    if (isAdopted) { if (asFather) target.adoptiveFatherId = focus.id; else target.adoptiveMotherId = focus.id; }
    else { if (asFather) target.fatherId = focus.id; else target.motherId = focus.id; }
    await DB.updatePerson(target);
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

let personYearPreset = null;
// yearを渡すと、年の選択をスキップしてその年のデータを直接開く(経歴年表・役職年表の年をタップした時用)
function openPersonYearView(id, year) {
  personYearFocusId = id;
  personYearPreset = year != null ? year : null;
  navigateTo('view-person-year');
}

function renderPersonYearView() {
  const p = personById(personYearFocusId);
  if (!p) { goBack(); return; }
  document.getElementById('person-year-view-title').textContent = `${p.name}の年代`;
  renderPersonYearSelect(p);
  // 年をタップして開いた時はその年、出来事を見て戻ってきた時は前に選んでいた年を出す
  const year = personYearPreset != null ? personYearPreset : personYearLast.get(p.id);
  personYearPreset = null;
  if (year != null && year !== '') {
    document.getElementById('person-year-select').value = String(year);
    renderPersonYearResult(p, year);
  }
}
const personYearLast = new Map(); // 人物ごとに最後に選んだ年(画面を戻った時に選び直さなくて済むように)

function renderPersonYearResult(p, yearVal) {
  const resultEl = document.getElementById('person-year-result');
  if (yearVal === '' || yearVal == null) { resultEl.innerHTML = ''; personYearLast.delete(p.id); return; }
  const year = Number(yearVal);
  personYearLast.set(p.id, year);
  const age = personAgeAt(p, year);
  const activeRoles = activePeriodItems(p.roles, 'role', year);
  const activeAffiliations = activePeriodItems(p.affiliations, 'affiliation', year);
  const activeQualifications = activePeriodItems(p.qualifications, 'qualification', year);
  const earnedMedals = (p.medals || []).filter((m) => m.startYear != null && m.startYear <= year)
    .map((m) => m.rank ? `${m.medal}(${m.rank})` : m.medal);
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
    .sort((a, b) => (a.kana || a.name || '').localeCompare(b.kana || b.name || '', 'ja')); // 人物一覧と同じく読み優先
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
  'view-org-chart': renderOrgChart,
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
    renderPeople(); // 内部でrefreshIndexTargetも呼ぶため、生年順の時はインデックスバーが自動で隠れる
  }));

  document.querySelectorAll('#view-events .filter-chips').forEach((bar) => bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    eventsCategoryFilter = chip.dataset.category;
    bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderEvents();
  }));

  document.querySelectorAll('#view-roles .filter-chips').forEach((bar) => bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    rolesCategoryFilter = chip.dataset.category;
    bar.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderRoles();
  }));

  const delegate = (id, selector, fn) => document.getElementById(id).addEventListener('click', (e) => {
    const el = e.target.closest(selector);
    if (el) fn(el);
  });

  delegate('search-results', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('people-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('event-participants', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('event-tier-table', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('events-list', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('event-children-list', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  // 経歴年表は、年の部分をタップした時だけ「年代で見る」を開く(それ以外=出来事名部分は出来事詳細を開く)
  document.getElementById('person-timeline').addEventListener('click', (e) => {
    const yearEl = e.target.closest('[data-year]');
    if (yearEl) { openPersonYearView(currentPersonId, Number(yearEl.dataset.year)); return; }
    const li = e.target.closest('[data-event-id]');
    if (li) openEventDetail(Number(li.dataset.eventId));
  });
  document.getElementById('person-roles-timeline').addEventListener('click', (e) => {
    const yearEl = e.target.closest('[data-year]');
    if (yearEl) openPersonYearView(currentPersonId, Number(yearEl.dataset.year));
  });
  delegate('year-lookup-events', '[data-event-id]', (el) => openEventDetail(Number(el.dataset.eventId)));
  delegate('year-lookup-people', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('roles-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('person-relationships', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('organizations-list', '[data-person-id]', (el) => openPersonDetail(Number(el.dataset.personId)));
  delegate('organizations-list', '[data-org-name]', (el) => openOrgEditor(el.dataset.orgName));
  delegate('organizations-list', '[data-org-chart]', (el) => { orgChartName = el.dataset.orgChart; orgChartYear = ''; navigateTo('view-org-chart'); });
  document.getElementById('org-chart-year').addEventListener('change', (e) => { orgChartYear = e.target.value; renderOrgChart(); });
  document.getElementById('org-chart-edit-btn').addEventListener('click', () => openOrgEditor(orgChartName));
  document.getElementById('org-chart-svg').addEventListener('click', (e) => {
    const box = e.target.closest('[data-chart-person]');
    if (box) openPersonDetail(Number(box.dataset.chartPerson));
  });

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
    const category = document.getElementById('bulk-role-category').value;
    const startVal = document.getElementById('bulk-role-start').value;
    const endVal = document.getElementById('bulk-role-end').value;
    const startYear = startVal ? clampYear(startVal) : null;
    const endYear = endVal ? clampYear(endVal) : null;
    for (const pid of bulkRoleCheckedIds) {
      const p = personById(pid);
      if (!p) continue;
      p.roles = [...(p.roles || []), { role, category, startYear, endYear }];
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
    const roleRows = bulkOrgRoleRows.filter((r) => (r.role || '').trim() && r.personId != null);
    if (bulkOrgRoleRows.some((r) => (r.role || '').trim() && r.personId == null)) { alert('役職に就いた人物を選んでください'); return; }
    const editing = editingOrgName != null;
    const peerages = bulkOrgPeerageRows.filter((r) => (r.title || '').trim())
      .map((r) => ({ title: r.title.trim(), startYear: r.startYear != null && r.startYear !== '' ? clampYear(r.startYear) : null }))
      .sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
    if (!editing && !bulkAffiliationCheckedIds.size && !roleRows.length && !peerages.length) { alert('所属する人物か、役職か、爵位を入れてください'); return; }
    if (editing && !bulkAffiliationCheckedIds.size && !roleRows.length && !bulkOrgMemberRows.length && !peerages.length
      && !confirm('所属する人物も役職も爵位もなくなるため、この組織は一覧から消えます。よろしいですか?')) return;
    const startVal = document.getElementById('bulk-affiliation-start').value;
    const endVal = document.getElementById('bulk-affiliation-end').value;
    const startYear = startVal ? clampYear(startVal) : null;
    const endYear = endVal ? clampYear(endVal) : null;
    const yearOf = (v) => (v != null && v !== '' ? clampYear(v) : null);
    const changed = new Map();
    const touch = (pid) => { const p = personById(pid); if (p) changed.set(pid, p); return p; };
    if (editing) {
      // 編集の時は、元の組織名の所属・役職をいったん全部外し、画面の内容(新しい名前)で入れ直す
      people.forEach((p) => {
        const hasAff = (p.affiliations || []).some((a) => a.affiliation === editingOrgName);
        const hasRole = (p.roles || []).some((r) => r.organization === editingOrgName);
        if (!hasAff && !hasRole) return;
        touch(p.id);
        p.affiliations = (p.affiliations || []).filter((a) => a.affiliation !== editingOrgName);
        p.roles = (p.roles || []).filter((r) => r.organization !== editingOrgName);
      });
      for (const m of bulkOrgMemberRows) {
        const p = touch(m.personId);
        if (p) p.affiliations = [...(p.affiliations || []), { affiliation, startYear: yearOf(m.startYear), endYear: yearOf(m.endYear) }];
      }
    }
    for (const pid of bulkAffiliationCheckedIds) {
      const p = touch(pid);
      if (p) p.affiliations = [...(p.affiliations || []), { affiliation, startYear, endYear }];
    }
    const byYear = (a, b) => (a.startYear ?? 0) - (b.startYear ?? 0);
    for (const r of roleRows) {
      const p = touch(r.personId);
      if (!p) continue;
      const rs = yearOf(r.startYear), re = yearOf(r.endYear);
      p.roles = [...(p.roles || []), { role: r.role.trim(), category: r.category || '', startYear: rs, endYear: re, organization: affiliation }].sort(byYear);
      // 役職に就いた人がこの組織に所属していなければ、役職の期間で所属も付ける
      if (!(p.affiliations || []).some((a) => a.affiliation === affiliation)) {
        p.affiliations = [...(p.affiliations || []), { affiliation, startYear: rs ?? startYear, endYear: re }];
      }
    }
    for (const p of changed.values()) {
      p.affiliations = dedupeAffiliations(p.affiliations).sort(byYear);
      await DB.updatePerson(p);
    }
    // 組織そのものの情報(爵位)は組織名をキーに保存する。名前を変えた時は古い名前の記録を消して移す
    if (editing && editingOrgName !== affiliation) await DB.deleteOrganization(editingOrgName);
    // 役職の順番(偉い順)も組織の情報として保存する。順番に無い役職が行で使われていれば後ろに足す
    const roleOrder = [...bulkOrgRoleOrder];
    roleRows.forEach((r) => { const role = r.role.trim(); if (!roleOrder.includes(role)) roleOrder.push(role); });
    if (peerages.length || roleOrder.length) {
      await DB.putOrganization({ ...(organizations.find((o) => o.name === affiliation) || {}), name: affiliation, peerages, roleOrder });
    } else if (editing || organizations.some((o) => o.name === affiliation)) await DB.deleteOrganization(affiliation);
    if (editing && orgChartName === editingOrgName) orgChartName = affiliation; // 組織図から編集して名前を変えた時、戻った組織図も新しい名前で出す
    await refreshAll();
    goBack();
  });

  document.getElementById('bulk-org-delete-btn').addEventListener('click', async () => {
    const name = editingOrgName;
    if (name == null) return;
    if (!confirm(`「${name}」を削除しますか?\n全員の所属と、この組織の役職が外れます(人物は削除されません)`)) return;
    for (const p of people) {
      const hasAff = (p.affiliations || []).some((a) => a.affiliation === name);
      const hasRole = (p.roles || []).some((r) => r.organization === name);
      if (!hasAff && !hasRole) continue;
      p.affiliations = (p.affiliations || []).filter((a) => a.affiliation !== name);
      p.roles = (p.roles || []).filter((r) => r.organization !== name);
      await DB.updatePerson(p);
    }
    await DB.deleteOrganization(name);
    await refreshAll();
    goBack();
  });

  document.getElementById('bulk-org-peerage-add-btn').addEventListener('click', () => {
    bulkOrgPeerageRows.push({ rowId: 'orgpeerage' + (bulkOrgPeerageSeq++), startYear: null, title: '' });
    renderBulkOrgPeerageList();
  });
  const orgPeerageList = document.getElementById('bulk-org-peerage-list');
  orgPeerageList.addEventListener('input', (e) => {
    const row = e.target.closest('.org-peerage-row');
    const draft = row && bulkOrgPeerageRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('og-start')) draft.startYear = e.target.value === '' ? null : Number(e.target.value);
    else if (e.target.classList.contains('og-title')) draft.title = e.target.value;
  });
  orgPeerageList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-org-peerage]');
    if (!btn) return;
    bulkOrgPeerageRows = bulkOrgPeerageRows.filter((r) => r.rowId !== btn.dataset.removeOrgPeerage);
    renderBulkOrgPeerageList();
  });

  const orgMemberList = document.getElementById('bulk-org-member-list');
  orgMemberList.addEventListener('input', (e) => {
    const row = e.target.closest('.org-member-row');
    const draft = row && bulkOrgMemberRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    const val = e.target.value === '' ? null : Number(e.target.value);
    if (e.target.classList.contains('om-start')) draft.startYear = val;
    else if (e.target.classList.contains('om-end')) draft.endYear = val;
  });
  orgMemberList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-org-member]');
    if (!btn) return;
    bulkOrgMemberRows = bulkOrgMemberRows.filter((r) => r.rowId !== btn.dataset.removeOrgMember);
    renderBulkOrgMemberList();
  });

  document.getElementById('bulk-org-role-add-btn').addEventListener('click', () => {
    if (!bulkOrgRoleOrder.length) { alert('先に上の「役職の順番」で役職を追加してください'); document.getElementById('bulk-org-role-order-name').focus(); return; }
    const last = bulkOrgRoleRows[bulkOrgRoleRows.length - 1];
    // 前の行の終了年を次の行の開始年に引き継ぐ(年代ごとに続けて入れやすいように)
    bulkOrgRoleRows.push({ rowId: 'orgrole' + (bulkOrgRoleSeq++), startYear: last ? last.endYear ?? null : null, endYear: null, role: last ? last.role : bulkOrgRoleOrder[0], category: last ? last.category : '', personId: null });
    renderBulkOrgRoleList();
  });
  const orgRoleList = document.getElementById('bulk-org-role-list');
  const orgRoleDraft = (el) => { const row = el.closest('.org-role-row'); return row && bulkOrgRoleRows.find((r) => r.rowId === row.dataset.rowId); };
  orgRoleList.addEventListener('input', (e) => {
    const draft = orgRoleDraft(e.target);
    if (!draft) return;
    if (e.target.classList.contains('ob-start')) draft.startYear = e.target.value === '' ? null : Number(e.target.value);
    else if (e.target.classList.contains('ob-end')) draft.endYear = e.target.value === '' ? null : Number(e.target.value);
    else if (e.target.classList.contains('ob-name')) draft.role = e.target.value;
  });
  orgRoleList.addEventListener('change', (e) => {
    const draft = orgRoleDraft(e.target);
    if (!draft) return;
    if (e.target.classList.contains('ob-category')) draft.category = e.target.value;
    else if (e.target.classList.contains('ob-name')) draft.role = e.target.value;
  });

  // 役職の順番: 追加・上下の入れ替え・削除(使っている役職は消せない)
  const addRoleToOrder = () => {
    const input = document.getElementById('bulk-org-role-order-name');
    const role = input.value.trim();
    if (!role) return;
    if (!bulkOrgRoleOrder.includes(role)) bulkOrgRoleOrder.push(role);
    input.value = '';
    renderBulkOrgRoleOrder();
    renderBulkOrgRoleList();
  };
  document.getElementById('bulk-org-role-order-add-btn').addEventListener('click', addRoleToOrder);
  document.getElementById('bulk-org-role-order-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRoleToOrder(); } });
  document.getElementById('bulk-org-role-order-list').addEventListener('click', (e) => {
    const up = e.target.closest('[data-order-up]');
    const down = e.target.closest('[data-order-down]');
    const remove = e.target.closest('[data-order-remove]');
    const swap = (i, j) => { [bulkOrgRoleOrder[i], bulkOrgRoleOrder[j]] = [bulkOrgRoleOrder[j], bulkOrgRoleOrder[i]]; };
    if (up) { const i = Number(up.dataset.orderUp); if (i > 0) swap(i, i - 1); }
    else if (down) { const i = Number(down.dataset.orderDown); if (i < bulkOrgRoleOrder.length - 1) swap(i, i + 1); }
    else if (remove) {
      const role = bulkOrgRoleOrder[Number(remove.dataset.orderRemove)];
      if (bulkOrgRoleRows.some((r) => r.role === role)) { alert(`「${role}」に就いている人がいるため消せません。先に下の役職の行を消すか、別の役職に変えてください`); return; }
      bulkOrgRoleOrder = bulkOrgRoleOrder.filter((r) => r !== role);
    } else return;
    renderBulkOrgRoleOrder();
    renderBulkOrgRoleList();
  });
  orgRoleList.addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('[data-remove-org-role]');
    if (removeBtn) {
      bulkOrgRoleRows = bulkOrgRoleRows.filter((r) => r.rowId !== removeBtn.dataset.removeOrgRole);
      renderBulkOrgRoleList();
      return;
    }
    if (!e.target.closest('.ob-person')) return;
    const draft = orgRoleDraft(e.target);
    if (!draft) return;
    const result = await openPersonPicker({ allowClear: true });
    if (!result || result.type === 'new') return;
    draft.personId = result.type === 'clear' ? null : result.id;
    renderBulkOrgRoleList();
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
  // 同じ顔ぶれで続く戦いなどを作りやすいように、参加者と陣営だけ引き継いだ新しい出来事を作る(生死・討ち取り・ティア・配置は引き継がない)
  document.getElementById('event-duplicate-btn').addEventListener('click', () => {
    const src = eventById(currentEventId);
    if (!src) return;
    openEventForm(null, src.parentEventId ?? null);
    document.getElementById('event-form-title').value = src.title;
    document.getElementById('event-form-category').value = src.category || '出来事';
    document.getElementById('event-form-year').value = src.year ?? '';
    draftParticipants = (src.participants || []).filter((p) => p.status !== '死亡') // その出来事で死亡した人は続きに出られないので外す
      .map((p) => ({ personId: p.personId, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [], faction: p.faction || '' }));
    renderEventFormParticipants();
    formDirty = true;
  });
  // 人物の画面から、その人物が参加者に入った状態で新しい出来事を作る
  document.getElementById('person-add-event-btn').addEventListener('click', () => {
    const p = personById(currentPersonId);
    if (!p) return;
    openEventForm(null);
    draftParticipants = [{ personId: p.id, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [], faction: currentFactionOf(p) }];
    renderEventFormParticipants();
  });
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

  document.getElementById('prompt-sheet-ok').addEventListener('click', () => resolvePromptSheet(document.getElementById('prompt-sheet-input').value));
  document.getElementById('prompt-sheet-cancel').addEventListener('click', () => resolvePromptSheet(null));
  document.getElementById('prompt-sheet-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') resolvePromptSheet(e.target.value);
  });
  document.getElementById('prompt-sheet').addEventListener('click', (e) => { if (e.target.id === 'prompt-sheet') resolvePromptSheet(null); });

  document.getElementById('person-picker-search').addEventListener('input', (e) => renderPersonPickerList(e.target.value));
  document.getElementById('person-picker-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-picker-person]');
    if (btn) closePersonPicker({ type: 'existing', id: Number(btn.dataset.pickerPerson) });
  });
  document.getElementById('person-picker-new').addEventListener('click', () => closePersonPicker({ type: 'new' }));
  document.getElementById('person-picker-clear').addEventListener('click', () => closePersonPicker({ type: 'clear' }));
  document.getElementById('person-picker-cancel').addEventListener('click', () => closePersonPicker(null));
  document.getElementById('person-picker-sheet').addEventListener('click', (e) => { if (e.target.id === 'person-picker-sheet') closePersonPicker(null); });
}

function wireForms() {
  document.getElementById('person-save-btn').addEventListener('click', savePersonForm);
  document.getElementById('event-save-btn').addEventListener('click', saveEventForm);

  // プルダウンで「+ 新しい人物を作成...」を選んだ時、その場で名前を聞いて人物を作り選択状態にする
  wirePersonPickerButton('person-form-father', 'person-form-father-picker', {
    getExcludeIds: () => (editingPersonId != null ? [editingPersonId] : []),
    allowClear: true,
    placeholder: '(未設定)',
    onChange: async (value) => {
      if (value !== NEW_PERSON_OPTION) return;
      const name = ((await promptText('父の名前を入力してください')) || '').trim();
      const newId = name ? await resolvePersonByName(name, editingPersonId) : null;
      populatePersonFormSelects({ father: newId != null ? String(newId) : '' });
    },
  });
  wirePersonPickerButton('person-form-mother', 'person-form-mother-picker', {
    getExcludeIds: () => (editingPersonId != null ? [editingPersonId] : []),
    allowClear: true,
    placeholder: '(未設定)',
    onChange: async (value) => {
      if (value !== NEW_PERSON_OPTION) return;
      const name = ((await promptText('母の名前を入力してください')) || '').trim();
      const newId = name ? await resolvePersonByName(name, editingPersonId) : null;
      populatePersonFormSelects({ mother: newId != null ? String(newId) : '' });
    },
  });
  wirePersonPickerButton('person-spouse-add', 'person-spouse-add-picker', {
    getExcludeIds: () => [...(editingPersonId != null ? [editingPersonId] : []), ...spouseDraftIds],
    placeholder: '選択してください',
  });
  wirePersonPickerButton('person-child-add', 'person-child-add-picker', {
    getExcludeIds: () => (editingPersonId != null ? [editingPersonId] : []),
    placeholder: '選択してください',
  });
  wirePersonPickerButton('person-adopted-child-add', 'person-adopted-child-add-picker', {
    getExcludeIds: () => (editingPersonId != null ? [editingPersonId] : []),
    placeholder: '選択してください',
  });
  wirePersonPickerButton('person-relationship-add-person', 'person-relationship-add-person-picker', {
    getExcludeIds: () => (editingPersonId != null ? [editingPersonId] : []),
    placeholder: '選択してください',
  });

  document.getElementById('event-form-add-btn').addEventListener('click', async () => {
    const sel = document.getElementById('event-form-add-person');
    const personId = await resolvePersonFromSelect(sel, '参加者');
    if (personId == null || draftParticipants.some((p) => p.personId === personId)) return;
    const addedPerson = personById(personId);
    draftParticipants.push({ personId, status: '生存', note: '', position: null, killedPersonIds: [], injuredPersonIds: [], faction: addedPerson ? currentFactionOf(addedPerson) : '' });
    renderEventFormParticipants();
    renderAddPersonSelect();
  });
  wirePersonPickerButton('event-form-add-person', 'event-form-add-person-picker', {
    getExcludeIds: () => draftParticipants.map((p) => p.personId),
    placeholder: '選択してください',
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
    } else if (e.target.classList.contains('pf-tier')) {
      draft.tier = e.target.value;
    }
  });
  participantsList.addEventListener('input', (e) => {
    const row = e.target.closest('.participant-row-wrap');
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const draft = draftParticipants.find((p) => p.personId === pid);
    if (!draft) return;
    if (e.target.classList.contains('pf-note')) draft.note = e.target.value;
    else if (e.target.classList.contains('pf-faction')) draft.faction = e.target.value;
    else if (e.target.classList.contains('pf-score')) draft.score = e.target.value;
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
    const categoryEl = document.getElementById('person-role-add-category');
    const role = nameEl.value.trim();
    if (!role) return;
    roleDraftRows.push({
      rowId: nextRoleRowId(), role, category: categoryEl.value,
      startYear: startEl.value ? clampYear(startEl.value) : null,
      endYear: endEl.value ? clampYear(endEl.value) : null,
    });
    startEl.value = ''; endEl.value = ''; nameEl.value = ''; categoryEl.value = '';
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
    else if (e.target.classList.contains('pr-org')) draft.organization = e.target.value;
  });
  roleList.addEventListener('change', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = roleDraftRows.find((r) => r.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pr-category')) draft.category = e.target.value;
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
    const rankEl = document.getElementById('person-medal-add-rank');
    const medal = nameEl.value.trim();
    if (!medal) return;
    medalDraftRows.push({ rowId: nextMedalRowId(), medal, rank: rankEl.value.trim(), startYear: startEl.value ? clampYear(startEl.value) : null });
    startEl.value = ''; nameEl.value = ''; rankEl.value = '';
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
    else if (e.target.classList.contains('pmd-rank')) draft.rank = e.target.value;
  });
  medalList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-medal]');
    if (!btn) return;
    medalDraftRows = medalDraftRows.filter((m) => m.rowId !== btn.dataset.removeMedal);
    renderMedalList();
  });

  document.getElementById('person-faction-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-faction-add-start');
    const nameEl = document.getElementById('person-faction-add-name');
    const faction = nameEl.value.trim();
    if (!faction) return;
    factionDraftRows.push({ rowId: nextFactionRowId(), faction, startYear: startEl.value ? clampYear(startEl.value) : null });
    startEl.value = ''; nameEl.value = '';
    renderFactionList();
  });
  const factionList = document.getElementById('person-faction-list');
  factionList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = factionDraftRows.find((f) => f.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pfc-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pfc-name')) draft.faction = e.target.value;
  });
  factionList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-faction]');
    if (!btn) return;
    factionDraftRows = factionDraftRows.filter((f) => f.rowId !== btn.dataset.removeFaction);
    renderFactionList();
  });

  document.getElementById('person-strength-add-btn').addEventListener('click', () => {
    const startEl = document.getElementById('person-strength-add-start');
    const tierEl = document.getElementById('person-strength-add-tier');
    const scoreEl = document.getElementById('person-strength-add-score');
    strengthDraftRows.push({
      rowId: nextStrengthRowId(), tier: tierEl.value, score: scoreEl.value,
      startYear: startEl.value ? clampYear(startEl.value) : null,
    });
    startEl.value = ''; scoreEl.value = '';
    renderStrengthList();
  });
  const strengthList = document.getElementById('person-strength-list');
  strengthList.addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = strengthDraftRows.find((s) => s.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pst-start')) draft.startYear = e.target.value ? clampYear(e.target.value) : null;
    else if (e.target.classList.contains('pst-score')) draft.score = e.target.value;
  });
  strengthList.addEventListener('change', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = strengthDraftRows.find((s) => s.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('pst-tier')) draft.tier = e.target.value;
  });
  strengthList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-strength]');
    if (!btn) return;
    strengthDraftRows = strengthDraftRows.filter((s) => s.rowId !== btn.dataset.removeStrength);
    renderStrengthList();
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

  document.getElementById('person-weapon-add-btn').addEventListener('click', () => {
    const nameEl = document.getElementById('person-weapon-add-name');
    const weapon = nameEl.value.trim();
    if (!weapon) return;
    weaponDraftRows.push({ rowId: nextWeaponRowId(), weapon });
    nameEl.value = '';
    renderWeaponList();
  });
  document.getElementById('person-weapon-list').addEventListener('input', (e) => {
    const row = e.target.closest('.summary-row');
    if (!row) return;
    const draft = weaponDraftRows.find((w) => w.rowId === row.dataset.rowId);
    if (draft && e.target.classList.contains('pwp-name')) draft.weapon = e.target.value;
  });
  document.getElementById('person-weapon-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-weapon]');
    if (!btn) return;
    weaponDraftRows = weaponDraftRows.filter((w) => w.rowId !== btn.dataset.removeWeapon);
    renderWeaponList();
  });

  document.getElementById('person-skill-add-btn').addEventListener('click', () => {
    const nameEl = document.getElementById('person-skill-add-name');
    const descEl = document.getElementById('person-skill-add-description');
    const skill = nameEl.value.trim();
    if (!skill) return;
    skillDraftRows.push({ rowId: nextSkillRowId(), skill, description: descEl.value.trim() });
    nameEl.value = '';
    descEl.value = '';
    renderSkillList();
  });
  document.getElementById('person-skill-list').addEventListener('input', (e) => {
    const row = e.target.closest('.skill-row');
    if (!row) return;
    const draft = skillDraftRows.find((s) => s.rowId === row.dataset.rowId);
    if (!draft) return;
    if (e.target.classList.contains('psk-name')) draft.skill = e.target.value;
    else if (e.target.classList.contains('psk-desc')) draft.description = e.target.value;
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

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// 確認の結果を、設定画面の表示とトーストの両方に出す(自動確認の結果も同じ欄に残す)
function reportUpdate(msg, manual) {
  const t = new Date();
  document.getElementById('update-status').textContent = `${msg}（${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')} に確認）`;
  if (manual) showToast(msg);
}

// 入力途中の画面では読み込み直さない(書きかけの内容が消えないように)
const UPDATE_BUSY_VIEWS = ['view-edit-person', 'view-edit-event', 'view-event-map-editor'];
const isUpdateBusy = () => UPDATE_BUSY_VIEWS.some((v) => document.getElementById(v).classList.contains('active'));
let pendingReload = false;
let updateInFlight = false;
const RELOADED_KEY = 'jinbutsuroku-reloaded-for';
// 新しいバージョンがあれば、そのファイル一式を(配信キャッシュを素通りして)取り、本当に新しい版かを確かめてから
// 新しいキャッシュに入れ、画面を読み込み直す。service-worker.js 自体は中身が変わらないリリースもあるので、
// ブラウザの更新チェックだけに頼らない
async function checkForUpdate(manual) {
  if (updateInFlight) return;
  if (!('caches' in window)) { if (manual) reportUpdate('このブラウザでは確認できません', true); return; }
  updateInFlight = true;
  const btn = document.getElementById('btn-check-update');
  if (manual) { btn.disabled = true; document.getElementById('update-status').textContent = '確認しています…'; }
  try {
    const latest = await fetchLatestVersion();
    if (latest === APP_VERSION) {
      try { sessionStorage.removeItem(RELOADED_KEY); } catch (e) { /* なくても動く */ }
      reportUpdate(`最新のバージョン（${APP_VERSION}）です`, manual);
      return;
    }
    // 読み込み直したのにまだ古いときは、自動では繰り返さない(読み込み直しが止まらなくなるのを防ぐ)
    let reloaded = null;
    try { reloaded = sessionStorage.getItem(RELOADED_KEY); } catch (e) { /* なくても動く */ }
    if (!manual && reloaded === latest) {
      reportUpdate(`新しいバージョン（${latest}）に切り替わりませんでした。「最新バージョンか確認する」を押してください`, false);
      return;
    }

    const entries = await fetchFreshAssets(latest);   // 古いファイルしか返らなければここで止まる(次の確認でやり直す)
    const name = 'jinbutsuroku-cache-' + latest;
    await caches.delete(name);                         // 前に途中まで入れたものがあれば捨てる
    const cache = await caches.open(name);
    await Promise.all(entries.map(([href, res]) => cache.put(href, res)));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== name).map((k) => caches.delete(k)));
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) reg.update().catch(() => {});
    try { sessionStorage.setItem(RELOADED_KEY, latest); } catch (e) { /* なくても動く */ }

    if (isUpdateBusy()) {
      pendingReload = true;
      reportUpdate(`新しいバージョン（${latest}）があります。編集を終えたら更新します`, true);
    } else {
      reportUpdate(`新しいバージョン（${latest}）に更新します`, true);
      setTimeout(() => location.reload(), 900);
    }
  } catch (e) {
    const msg = String(e.message || '').includes('まだ')
      ? '新しいバージョンを公開した直後で、まだ準備中です。数分後にもう一度確認してください'
      : '確認できませんでした。通信状態を確かめてください';
    reportUpdate(msg, manual);
  } finally {
    updateInFlight = false;
    btn.disabled = false;
  }
}

function wireUpdateCheck() {
  document.getElementById('btn-check-update').addEventListener('click', () => checkForUpdate(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(false); });
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
  setupIndexBar();
  document.getElementById('app-version').textContent = APP_VERSION;
  document.getElementById('app-version-home').textContent = 'v' + APP_VERSION;
  applyView('view-search');
  if ('serviceWorker' in navigator) {
    // service-worker.js が読み込むファイル(version.js など)もブラウザのキャッシュを通さずに更新を確かめる
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).catch(() => {});
  }
  checkForUpdate(false); // 開いたときに、裏で新しいバージョンがないか確認する
}

document.addEventListener('DOMContentLoaded', init);
