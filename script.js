// --- shared backend integration --------------------------------------------
// All structured state lives on the server (see server/server.js).
// Only the per-browser current user is kept in localStorage so each device
// stays "logged in" across reloads.
const API_BASE = "api";
const LOCAL_USER_KEY = "aicp-sop-current-user-v1";
const DEFAULT_WORK_DATE = "2026-05-06";
let stateVersion = 0;
let lastSyncedAt = "";
let saveQueue = Promise.resolve();
let pollTimer = null;
const POLL_INTERVAL_MS = 4000;
let kbFiles = [];

function todayKey() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const ALL_SCHEDULE_DATES = "ALL";
let activeScheduleDate = ALL_SCHEDULE_DATES;

function apiUrl(path) {
  return `${API_BASE}/${path.replace(/^\/+/, "")}`;
}

async function apiJson(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`API ${path} -> HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const EMPTY_USER = {
  name: "",
  phone: "",
  unit: "",
  role: "",
  loginAt: "",
};

// 注意：phone 为空时 mergeUsers 会用 `name-unit` 当 key 去重；
// 不要把多人的 phone 占位填成同一个字符串（如 "待补充"），否则会互相吞并。
const defaultUsers = [
  { name: "黄晓瑜", phone: "", unit: "苏州移动 网络部", role: "管理", loginAt: "" },
  { name: "邵新", phone: "", unit: "苏州移动 网络部", role: "管理", loginAt: "" },
  { name: "周岗", phone: "", unit: "苏州铁通", role: "网络", loginAt: "" },
  { name: "钟队长", phone: "", unit: "相城区装维", role: "装维", loginAt: "" },
  { name: "邓师傅", phone: "", unit: "园区装维", role: "装维", loginAt: "" },
  { name: "蔡俊", phone: "18500039693", unit: "好活", role: "管理", loginAt: "" },
  { name: "张明昊", phone: "18662678967", unit: "好活", role: "开发", loginAt: "" },
  { name: "王子寅", phone: "13372152239", unit: "好活", role: "运营", loginAt: "" },
  { name: "丁金辉", phone: "18506245595", unit: "好活", role: "运营", loginAt: "" },
  { name: "李明", phone: "15895638281", unit: "好活", role: "管理", loginAt: "" },
  { name: "AI", phone: "19900000000", unit: "好活", role: "开发", loginAt: "" },
];

// 场景 ID 命名规则：KB-<类型缩写>-<3位序号>
//   所有场景统一使用 KB- 前缀，避免旧演练 ID 混入下拉项。
//   类型缩写：LC=装维流程 GZ=故障诊断 TS=投诉预处理 SX=随销
//   示例：KB-LC-001（知识库·装维流程）、KB-SX-005（知识库·随销）
const SCENE_TYPE_CODES = {
  SX: "随销",
  LC: "装维流程",
  GZ: "故障诊断",
  TS: "投诉预处理",
};

// 穿越日程数据来源：/Users/zhujmac/AICP/SOP/kb/AICP-01.xlsx（2026-05-10 同步）
const AICP_SCHEDULE_ROWS = [
  {
    date: "2026-05-06",
    period: "上午",
    time: "10:00-12:30",
    sceneId: "-",
    target: "AICP项目背景同步及装维工程师工作流程梳理",
    location: "苏州铁通4F会议室",
    owner: "黄晓瑜",
    participants: "苏州移动 网络部：黄晓瑜\n后台支撑*2+装维队长*1+装维队员*1\n好活科技：蔡俊、李明、张明昊、丁金辉、王子寅",
    status: "通过",
    outcome: "装维工程师日工作流",
    photos: [
      "assets/schedule/ID_F88676759406428A9829A82272F2CFD9.jpg",
      "assets/schedule/ID_3129EE96A2D744C48D3EF010DCC0AD28.jpg",
    ],
  },
  {
    date: "2026-05-06",
    period: "下午",
    time: "13:30-16:30",
    sceneId: "-",
    target: "装维工程师场景梳理",
    location: "苏州铁通4F会议室",
    owner: "邵新",
    participants: "苏州移动 网络部：邵新\n装维队长*1+装维队员*1\n好活科技：蔡俊、丁金辉",
    status: "通过",
    outcome: "装维工程师日工作流",
    photos: ["assets/schedule/ID_6F7A73C35ECE4EB58049CEC02B95376C.jpg"],
  },
  {
    date: "2026-05-06",
    period: "下午",
    time: "14:30-16:00",
    sceneId: "-",
    target: "装维工程师随销产品梳理",
    location: "苏州铁通4F小会议室",
    owner: "邵新",
    participants: "苏州移动 网络部：邵新\n吴中营业员*3+后台支撑*1\n好活科技：张明昊、王子寅",
    status: "通过",
    outcome: "装维工程师随销产品梳理",
    photos: ["assets/schedule/ID_E197F26E464A4C5EB03BE775C2BD90BC.jpg"],
  },
  {
    date: "2026-05-07",
    period: "上午",
    time: "9:30-12:00",
    sceneId: "-",
    target: "复盘及装维工程师故障单业务类型梳理",
    location: "苏州铁通4F会议室",
    owner: "邵新",
    participants: "苏州移动 网络部：邵新\n苏州铁通：周岗\n后台支撑*1\n好活科技：蔡俊、张明昊、丁金辉、王子寅",
    status: "通过",
    outcome: "5月6日调研纪要",
    photos: ["assets/schedule/ID_38AB2A1F99204936A78A519DC47D4670.jpg"],
  },
  {
    date: "2026-05-07",
    period: "下午",
    time: "13:30-15:30",
    sceneId: "-",
    target: "装维工程师故障单业务类型梳理",
    location: "苏州铁通4F会议室",
    owner: "黄晓瑜",
    participants: "苏州移动 网络部：黄晓瑜\n后台支撑*1\n好活科技：蔡俊、张明昊、丁金辉、王子寅",
    status: "通过",
    outcome: "装维工程师故障单排障方案梳理",
    photos: ["assets/schedule/ID_24DB9843DCC54F7C83CE7F9AC733AAAB.jpg"],
  },
  {
    date: "2026-05-08",
    period: "下午",
    time: "15:00-20:00",
    sceneId: "-",
    target: "AICP项目背景同步及装维工程师场景演绎剧本同步",
    location: "苏州铁通4F会议室",
    owner: "蔡俊",
    participants: "好活科技：蔡俊、张明昊、丁金辉、王子寅\n相城区装维：钟队长\n园区装维：邓师傅",
    status: "通过",
    outcome: "装维工程师工作流程梳理图",
    photos: [
      "assets/schedule/ID_0C75DD7978664C489C3F65690E9039B0.jpg",
      "assets/schedule/ID_1FF8DCB64EDF475FBFC5316711534AFC.jpg",
      "assets/schedule/ID_C3CD752E0E41483F84137C68A8EF7A28.jpg",
      "assets/schedule/ID_BAB16E507BEA4C7881A6E5787560896F.jpg",
    ],
  },
];

const AICP_DAILY_SCHEDULES = AICP_SCHEDULE_ROWS.reduce((groups, row) => {
  groups[row.date] = groups[row.date] || [];
  groups[row.date].push({ ...row });
  return groups;
}, {});

const initialDictionaries = {
  sceneTypes: ["随销", "装维流程", "故障诊断", "投诉预处理"],
  statuses: ["未开始", "穿越中", "通过", "需复盘", "阻塞"],
  results: ["通过", "部分通过", "未通过", "待确认"],
  rounds: ["1", "2", "3"],
  devices: ["录音卡", "AI耳机", "手机录音", "会议录音", "手机录像", "其他"],
  audioStatuses: ["待上传", "已上传", "已转写", "已分析", "需重录", "不可用"],
  issueTypes: ["知识缺失", "规则缺失", "话术不准", "接口/数据", "流程不闭环", "权限/合规", "体验问题", "埋点缺失"],
  priorities: ["P0-必须当天解决", "P1-本周解决", "P2-可排期", "P3-观察"],
  impact: ["是", "否", "部分影响"],
  issueStatuses: ["待确认", "待开发", "开发中", "待验收", "已关闭", "暂缓"],
  roles: ["网络", "市场", "装维", "营业厅", "开发", "运营", "管理"],
  sceneTags: ["测试数据"],
};

const dictionaryLabels = {
  sceneTypes: "场景类型",
  statuses: "通用状态",
  results: "穿越结果",
  rounds: "轮次",
  devices: "采集设备",
  audioStatuses: "录音分析状态",
  issueTypes: "问题类型",
  priorities: "优先级",
  impact: "是否影响穿越",
  issueStatuses: "问题状态",
  roles: "角色",
  sceneTags: "场景标签",
};

const sampleSubmitter = {
  tags: "测试数据",
  submitterName: "AI",
  submitterPhone: "19900000000",
  submitterUnit: "好活",
  submitterRole: "开发",
  collectorName: "AI",
  collectorPhone: "19900000000",
  collectorUnit: "好活",
  collectorRole: "开发",
  updatedByName: "AI",
  updatedByPhone: "19900000000",
  updatedByUnit: "好活",
  updatedByRole: "开发",
};

const initialData = {
  scenes: [],
  schedule: structuredClone(AICP_DAILY_SCHEDULES[DEFAULT_WORK_DATE] || []),
  // NOTE: records/audio/issues are intentionally empty in initialData.
  // The frontend's normalizeState() falls back to these arrays whenever
  // the server returns an empty state object. If we shipped non-empty
  // samples here, the first user to load + save (after a fresh deploy or
  // a state reset) would silently push those samples into the canonical
  // shared state — polluting prod for everyone. If you need demo content,
  // import it explicitly via server/import-state.mjs instead.
  records: [],
  audio: [],
  issues: [],
  currentUser: structuredClone(EMPTY_USER),
  users: structuredClone(defaultUsers),
  dictionaries: structuredClone(initialDictionaries),
  dailySchedules: structuredClone(AICP_DAILY_SCHEDULES),
  dailySummaries: {},
  summary: {
    completed: "",
    topAudio: "",
    aiGap: "",
    blocker: "",
    rerun: "",
    next: "",
  },
};

let state = loadState();
const filters = {
  schedule: "",
  sceneCards: "",
  records: "",
  audio: "",
  issues: "",
};

const sceneQuery = {
  text: "",
  type: "",
  status: "",
  owner: "",
  tag: "",
  keyword: "",
};

// Audio blobs live on the shared server. saveAudioBlob uploads an mp3 and
// returns its server-side metadata; getAudioUrl gives a streaming URL the
// browser can drop straight into <audio src>.
async function saveAudioBlob(id, file) {
  if (!file || !file.size) return null;
  const form = new FormData();
  form.append("file", file, normalizeMp3(file.name));
  form.append("fileName", normalizeMp3(file.name));
  const res = await fetch(apiUrl(`audio/${encodeURIComponent(id)}`), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`audio upload failed (HTTP ${res.status})`);
  const stored = await res.json();
  await verifyAudioBlob(id, stored.size || file.size);
  return stored;
}

async function verifyAudioBlob(id, expectedSize) {
  const res = await fetch(apiUrl(`audio/${encodeURIComponent(id)}`), { method: "HEAD" });
  if (!res.ok) throw new Error(`server audio verify failed (HTTP ${res.status})`);
  const serverSize = Number(res.headers.get("Content-Length") || 0);
  if (expectedSize && serverSize !== Number(expectedSize)) {
    throw new Error(`server audio size mismatch (${serverSize}/${expectedSize})`);
  }
  return true;
}

function getAudioUrl(id) {
  // Cache-bust on uploadedAt so re-uploads bypass the browser cache.
  const audio = state?.audio?.find((item) => item.id === id);
  const v = audio?.audioUploadedAt ? `?v=${encodeURIComponent(audio.audioUploadedAt)}` : "";
  return apiUrl(`audio/${encodeURIComponent(id)}${v}`);
}

async function deleteAudioBlob(id) {
  await fetch(apiUrl(`audio/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => {});
}

async function saveVideoBlob(id, file) {
  if (!file || !file.size) return null;
  const form = new FormData();
  form.append("file", file, normalizeMp4(file.name));
  form.append("fileName", normalizeMp4(file.name));
  const res = await fetch(apiUrl(`video/${encodeURIComponent(id)}`), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`video upload failed (HTTP ${res.status})`);
  const stored = await res.json();
  await verifyVideoBlob(id, stored.size || file.size);
  return stored;
}

async function verifyVideoBlob(id, expectedSize) {
  const res = await fetch(apiUrl(`video/${encodeURIComponent(id)}`), { method: "HEAD" });
  if (!res.ok) throw new Error(`server video verify failed (HTTP ${res.status})`);
  const serverSize = Number(res.headers.get("Content-Length") || 0);
  if (expectedSize && serverSize !== Number(expectedSize)) {
    throw new Error(`server video size mismatch (${serverSize}/${expectedSize})`);
  }
  return true;
}

function getVideoUrl(id) {
  const item = state?.audio?.find((audio) => audio.id === id);
  const v = item?.videoUploadedAt ? `?v=${encodeURIComponent(item.videoUploadedAt)}` : "";
  return apiUrl(`video/${encodeURIComponent(id)}${v}`);
}

async function deleteVideoBlob(id) {
  await fetch(apiUrl(`video/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => {});
}

// Bootstrap-time placeholder: returns a normalized empty state with the
// per-browser current user (if any) restored from localStorage. The real data
// is fetched from the server immediately after via hydrateFromServer().
function loadState() {
  const local = readLocalCurrentUser();
  return normalizeState({ currentUser: local });
}

function readLocalCurrentUser() {
  try {
    const raw = localStorage.getItem(LOCAL_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalCurrentUser(user) {
  try {
    if (user && user.name) {
      localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(LOCAL_USER_KEY);
    }
  } catch {}
}

async function hydrateFromServer() {
  const { ok, body } = await apiJson("state");
  if (!ok) throw new Error("failed to load shared state");
  stateVersion = body.version || 0;
  lastSyncedAt = body.updatedAt || "";
  applyServerState(body.data || {});
}

function applyServerState(serverData) {
  const currentUser = state?.currentUser?.name ? state.currentUser : readLocalCurrentUser();
  state = normalizeState({ ...serverData, currentUser });
  renderAll();
  syncFormOptions();
}

// Used when the server reports a version conflict. Local edits beat server
// values entity-by-entity (id-keyed merge), keeping the user's in-flight work
// while still picking up other users' additions.
function mergeStates(localData, serverData) {
  const merged = { ...serverData, ...localData };
  for (const key of ["scenes", "records", "audio", "issues"]) {
    const localList = Array.isArray(localData[key]) ? localData[key] : [];
    const serverList = Array.isArray(serverData[key]) ? serverData[key] : [];
    const byId = new Map();
    for (const item of serverList) if (item && item.id) byId.set(item.id, item);
    for (const item of localList) if (item && item.id) byId.set(item.id, item);
    merged[key] = Array.from(byId.values());
  }
  if (localData.dictionaries || serverData.dictionaries) {
    merged.dictionaries = { ...(serverData.dictionaries || {}), ...(localData.dictionaries || {}) };
  }
  if (Array.isArray(localData.users) || Array.isArray(serverData.users)) {
    const byKey = new Map();
    for (const u of serverData.users || []) byKey.set(u.phone || u.name, u);
    for (const u of localData.users || []) byKey.set(u.phone || u.name, u);
    merged.users = Array.from(byKey.values());
  }
  if (localData.dailySchedules || serverData.dailySchedules) {
    merged.dailySchedules = {
      ...(serverData.dailySchedules || {}),
      ...(localData.dailySchedules || {}),
    };
  }
  if (localData.dailySummaries || serverData.dailySummaries) {
    merged.dailySummaries = {
      ...(serverData.dailySummaries || {}),
      ...(localData.dailySummaries || {}),
    };
  }
  return merged;
}

function normalizeState(saved) {
  const base = structuredClone(initialData);
  const merged = { ...base, ...saved };
  merged.scenes = (merged.scenes || []).map((scene) => ({
    tags: "测试数据",
    ...scene,
    tags: scene.tags || "测试数据",
  }));
  for (const key of ["records", "audio", "issues"]) {
    merged[key] = (merged[key] || []).map((item) => ({
      tags: "测试数据",
      ...item,
      tags: item.tags || "测试数据",
    }));
  }
  merged.dictionaries = { ...base.dictionaries, ...(saved.dictionaries || {}) };
  merged.dictionaries.sceneTags = uniqueList(["测试数据", ...(merged.dictionaries.sceneTags || [])]);
  merged.currentUser = { ...EMPTY_USER, ...(saved.currentUser || {}) };
  merged.users = mergeUsers(defaultUsers, saved.users || []);
  merged.dailySchedules = { ...(saved.dailySchedules || {}) };
  merged.dailySummaries = { ...(saved.dailySummaries || {}) };
  if (!merged.dailySchedules[DEFAULT_WORK_DATE]) {
    merged.dailySchedules[DEFAULT_WORK_DATE] = structuredClone(saved.schedule || base.schedule || []);
  }
  if (!merged.dailySummaries[DEFAULT_WORK_DATE]) {
    merged.dailySummaries[DEFAULT_WORK_DATE] = { ...base.summary, ...(saved.summary || {}) };
  }
  merged.schedule = getScheduleForDate(DEFAULT_WORK_DATE, merged);
  merged.summary = getSummaryForDate(DEFAULT_WORK_DATE, merged);
  return merged;
}

function cloneScheduleTemplate(source = initialData.schedule) {
  return structuredClone(source || []).map((row) => {
    const next = Array.isArray(row) ? [...row] : { ...row, photos: [...(row.photos || [])] };
    if (Array.isArray(next) && next.length >= 8) next[7] = "未开始";
    if (!Array.isArray(next)) next.status = "未开始";
    return next;
  });
}

function emptySummary() {
  return {
    completed: "",
    topAudio: "",
    aiGap: "",
    blocker: "",
    rerun: "",
    next: "",
  };
}

function getScheduleForDate(date = activeScheduleDate, source = state) {
  if (!source.dailySchedules) source.dailySchedules = {};
  if (!source.dailySchedules[date]) {
    source.dailySchedules[date] = cloneScheduleTemplate(initialData.dailySchedules?.[date] || source.dailySchedules[DEFAULT_WORK_DATE] || source.schedule || initialData.schedule);
  }
  return source.dailySchedules[date];
}

function getSummaryForDate(date = DEFAULT_WORK_DATE, source = state) {
  if (!source.dailySummaries) source.dailySummaries = {};
  if (!source.dailySummaries[date]) source.dailySummaries[date] = emptySummary();
  return source.dailySummaries[date];
}

function syncLegacyDailyFields(date) {
  if (date === DEFAULT_WORK_DATE) {
    state.schedule = getScheduleForDate(DEFAULT_WORK_DATE);
    state.summary = getSummaryForDate(DEFAULT_WORK_DATE);
  }
}

function mergeUsers(...groups) {
  const users = [];
  groups.flat().forEach((user) => {
    const key = user.phone || `${user.name}-${user.unit}`;
    const existing = users.find((item) => (item.phone || `${item.name}-${item.unit}`) === key || item.name === user.name);
    if (existing) {
      Object.assign(existing, { ...EMPTY_USER, ...existing, ...user });
    } else {
      users.push({ ...EMPTY_USER, ...user });
    }
  });
  return users;
}

function uniqueList(items) {
  return Array.from(new Set(items.map((item) => String(item || "").trim()).filter(Boolean)));
}

// Saves the current state to the server. Renders + persists locally first
// (so the UI feels instant), then PUTs in the background. Concurrent saves
// from this tab are serialized so version numbers stay consistent. If another
// browser raced us, the server's data is merged with ours (ours wins for
// entities we both touched) and we PUT again.
function saveState(successMessage = "") {
  writeLocalCurrentUser(state.currentUser);
  renderAll();
  syncFormOptions();
  showSyncStatus("saving");
  saveQueue = saveQueue
    .then(() => pushStateToServer())
    .then(() => {
      if (successMessage) showToast(successMessage, "success");
    })
    .catch((err) => {
      console.warn("save chain error", err);
      if (successMessage) showToast(`保存失败：${err.message}`, "error");
    });
  return saveQueue;
}

function stripLocalOnly(data) {
  // currentUser is per-browser; never push it to the shared store.
  const { currentUser: _drop, ...rest } = data || {};
  return rest;
}

async function pushStateToServer(retry = 0) {
  const payload = stripLocalOnly(state);
  let res;
  try {
    res = await apiJson("state", {
      method: "PUT",
      body: JSON.stringify({ data: payload, expectedVersion: stateVersion }),
    });
  } catch (err) {
    showSyncStatus("offline", "保存失败：连不上服务器，请检查网络。");
    throw err;
  }
  if (res.status === 409) {
    if (retry > 3) {
      showSyncStatus("error", "数据反复冲突，请刷新页面后重试。");
      return;
    }
    const serverData = res.body.serverData || {};
    stateVersion = res.body.currentVersion || stateVersion;
    const merged = mergeStates(payload, serverData);
    state = normalizeState({ ...merged, currentUser: state.currentUser });
    renderAll();
    syncFormOptions();
    showSyncStatus("merged", `已合并其他人的修改（v${stateVersion}）`);
    return pushStateToServer(retry + 1);
  }
  if (res.ok && res.body) {
    stateVersion = res.body.version || stateVersion;
    lastSyncedAt = res.body.updatedAt || lastSyncedAt;
    showSyncStatus("ok");
  }
}

function showSyncStatus(kind, message) {
  const pill = document.getElementById("syncPill");
  if (!pill) return;
  pill.dataset.kind = kind;
  if (kind === "ok") {
    pill.textContent = `已同步 v${stateVersion}`;
  } else if (kind === "saving") {
    pill.textContent = "保存中…";
  } else if (kind === "merged") {
    pill.textContent = message || "已合并";
  } else if (kind === "offline") {
    pill.textContent = message || "离线";
  } else if (kind === "error") {
    pill.textContent = message || "同步失败";
  } else if (kind === "newer") {
    pill.textContent = message || "有新数据";
  } else {
    pill.textContent = message || kind;
  }
}

function toastHost() {
  let host = document.getElementById("toastStack");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastStack";
    host.className = "toast-stack";
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  return host;
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  toast.textContent = message;
  toastHost().append(toast);
  setTimeout(() => toast.remove(), 3200);
}

function doubleConfirm(title, detail = "") {
  const first = [title, detail].filter(Boolean).join("\n\n");
  if (!confirm(first)) return false;
  return confirm(`再次确认：${title}${detail ? `\n\n${detail}` : ""}`);
}

async function pollForUpdates() {
  try {
    const { ok, body } = await apiJson("state/version");
    if (!ok) return;
    if (body.version && body.version > stateVersion) {
      // Don't blow away in-flight edits inside scene cards or forms.
      const editing = document.activeElement?.closest?.(".scene-card, form, textarea, input, select");
      if (editing) {
        showSyncStatus("newer", `有新数据 v${body.version}（点同步状态刷新）`);
        return;
      }
      await hydrateFromServer();
      showSyncStatus("ok");
    }
  } catch {
    // network blip — silent
  }
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function getScene(id) {
  return state.scenes.find((scene) => scene.id === id) || state.scenes[0] || {
    id: "",
    target: "",
    description: "",
    keywords: "",
    devSupport: "",
    tags: "测试数据",
  };
}

function dict(key) {
  return state.dictionaries?.[key] || initialDictionaries[key] || [];
}

function matchesQuery(item, query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return true;
  return JSON.stringify(item).toLowerCase().includes(text);
}

function hasUser() {
  return Boolean(state.currentUser?.name && state.currentUser?.unit && state.currentUser?.role);
}

function currentUserFields() {
  return {
    submitterName: state.currentUser?.name || "",
    submitterPhone: state.currentUser?.phone || "",
    submitterUnit: state.currentUser?.unit || "",
    submitterRole: state.currentUser?.role || "",
    collectorName: state.currentUser?.name || "",
    collectorPhone: state.currentUser?.phone || "",
    collectorUnit: state.currentUser?.unit || "",
    collectorRole: state.currentUser?.role || "",
  };
}

function submitterText(item) {
  const name = item.submitterName || item.collectorName || item.updatedByName || "";
  const unit = item.submitterUnit || item.collectorUnit || item.updatedByUnit || "";
  const role = item.submitterRole || item.collectorRole || item.updatedByRole || "";
  return [name, unit, role].filter(Boolean).map(escapeHtml).join("<br />");
}

function submitterValues(item) {
  return [
    item.submitterName || item.collectorName || item.updatedByName || "",
    item.submitterPhone || item.collectorPhone || item.updatedByPhone || "",
    item.submitterUnit || item.collectorUnit || item.updatedByUnit || "",
    item.submitterRole || item.collectorRole || item.updatedByRole || "",
  ];
}

function renderLoginState() {
  document.body.classList.toggle("login-open", !hasUser());
  $("#loginScreen").hidden = hasUser();
  $("#currentUserPill").textContent = hasUser()
    ? `${state.currentUser.name}｜${state.currentUser.unit}｜${state.currentUser.role}`
    : "未登录";
  renderQuickUsers();
}

function renderQuickUsers() {
  const box = document.querySelector(".quick-users");
  if (!box) return;
  box.innerHTML = `<span>默认人员</span>${state.users
    .map((user) => `<button class="ghost" type="button" data-quick-user="${attr(user.name)}">${escapeHtml(user.name)}</button>`)
    .join("")}`;
}

function statusClass(value) {
  if (["通过", "已分析", "已关闭"].includes(value)) return "done";
  if (["需复盘", "部分通过", "待上传", "待开发", "待确认"].includes(value)) return "warn";
  return "";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAll() {
  renderKpis();
  renderSchedule();
  renderSceneQuery();
  renderScenes();
  renderRecords();
  renderAudio();
  renderIssues();
  renderUsers();
  renderDictionaries();
  renderLoginState();
  hydrateAudioPlayers();
}

function scheduleDateList() {
  const dates = Object.keys(state.dailySchedules || {})
    .filter((date) => Array.isArray(state.dailySchedules[date]) && state.dailySchedules[date].length)
    .sort();
  return dates;
}

function formatScheduleDateLabel(date) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function renderScheduleTabs() {
  const tabs = $("#scheduleDateTabs");
  if (!tabs) return;
  const dates = scheduleDateList();
  const items = [{ value: ALL_SCHEDULE_DATES, label: "全部" }, ...dates.map((d) => ({ value: d, label: formatScheduleDateLabel(d) }))];
  tabs.innerHTML = items
    .map(
      (item) => `<button type="button" class="schedule-tab${item.value === activeScheduleDate ? " active" : ""}" data-schedule-tab="${attr(item.value)}" role="tab" aria-selected="${item.value === activeScheduleDate}">${escapeHtml(item.label)}</button>`,
    )
    .join("");
}

function renderKpis() {
  $("#kpiScenes").textContent = state.scenes.length;
  $("#kpiRecords").textContent = state.records.length;
  $("#kpiAudio").textContent = state.audio.filter((item) => item.audioName).length;
  $("#kpiMinutes").textContent = state.audio.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  $("#kpiOpenIssues").textContent = state.issues.filter((issue) => !["已关闭", "暂缓"].includes(issue.status)).length;
}

function scheduleValue(row, key) {
  if (!Array.isArray(row)) return row?.[key] || "";
  const indexMap = {
    period: 0,
    time: 1,
    sceneId: 2,
    target: 3,
    location: 4,
    owner: 5,
    participants: 6,
    status: 7,
    outcome: 8,
  };
  return row[indexMap[key]] || "";
}

function schedulePhotos(row) {
  return Array.isArray(row) ? [] : row?.photos || [];
}

function scheduleSearchText(row) {
  return {
    period: scheduleValue(row, "period"),
    time: scheduleValue(row, "time"),
    sceneId: scheduleValue(row, "sceneId"),
    target: scheduleValue(row, "target"),
    location: scheduleValue(row, "location"),
    owner: scheduleValue(row, "owner"),
    participants: scheduleValue(row, "participants"),
    outcome: scheduleValue(row, "outcome"),
    status: scheduleValue(row, "status"),
  };
}

function renderSchedulePhotos(row) {
  const photos = schedulePhotos(row);
  if (!photos.length) return `<span class="muted">无</span>`;
  return `<div class="schedule-photos">${photos
    .map(
      (src, index) => `
        <button class="schedule-photo" type="button" data-zoom-src="${attr(src)}" data-zoom-title="${attr(scheduleValue(row, "target"))} 照片${index + 1}">
          <img src="${attr(src)}" alt="${attr(scheduleValue(row, "target"))} 照片${index + 1}" loading="lazy" />
        </button>
      `,
    )
    .join("")}</div>`;
}

function renderSchedule() {
  renderScheduleTabs();
  const dates = scheduleDateList();
  const targetDates = activeScheduleDate === ALL_SCHEDULE_DATES ? dates : [activeScheduleDate];
  const rows = targetDates.flatMap((date) =>
    (state.dailySchedules?.[date] || []).map((row, index) => ({ row, date, index })),
  );
  $("#scheduleBody").innerHTML = rows
    .filter(({ row }) => matchesQuery(scheduleSearchText(row), filters.schedule))
    .map(
      ({ row, date, index }) => `
        <tr>
          <td class="col-date">${escapeHtml(formatScheduleDateLabel(date))}</td>
          <td><span class="tag">${escapeHtml(scheduleValue(row, "period"))}</span></td>
          <td>${escapeHtml(scheduleValue(row, "time"))}</td>
          <td class="schedule-target">${escapeHtml(scheduleValue(row, "target"))}</td>
          <td>${escapeHtml(scheduleValue(row, "location"))}</td>
          <td>${escapeHtml(scheduleValue(row, "owner"))}</td>
          <td class="schedule-participants">${escapeHtml(scheduleValue(row, "participants")).replaceAll("\n", "<br />")}</td>
          <td>${escapeHtml(scheduleValue(row, "outcome"))}</td>
          <td>${renderSchedulePhotos(row)}</td>
          <td><select data-schedule-date="${attr(date)}" data-schedule-index="${index}">${dict("statuses")
            .map((option) => `<option ${option === scheduleValue(row, "status") ? "selected" : ""}>${option}</option>`)
            .join("")}</select></td>
        </tr>
      `,
    )
    .join("");
}

function renderScenes() {
  $("#sceneGrid").innerHTML = state.scenes
    .filter((scene) => matchesQuery(scene, filters.sceneCards))
    .map(
      (scene) => `
        <article class="scene-card" data-scene-card="${scene.id}">
          <div class="scene-meta">
            <span class="tag">${scene.id}</span>
            <label>
              <span>场景类型</span>
              <select data-scene-field="type">${dict("sceneTypes")
                .map((option) => `<option ${option === scene.type ? "selected" : ""}>${option}</option>`)
                .join("")}</select>
            </label>
            <label>
              <span>状态</span>
              <select data-scene-field="status">${dict("statuses")
                .map((option) => `<option ${option === scene.status ? "selected" : ""}>${option}</option>`)
                .join("")}</select>
            </label>
          </div>
          <label><span>目标场景</span><input data-scene-field="target" value="${attr(scene.target)}" /></label>
          <label><span>场景描述</span><textarea data-scene-field="description">${escapeHtml(scene.description)}</textarea></label>
          <label><span>录音文件</span><input data-scene-field="audioName" value="${attr(scene.audioName)}" /></label>
          <label><span>关联场景</span><input data-scene-field="relatedScenes" value="${attr(scene.relatedScenes)}" /></label>
          <div class="scene-row">
            <label>
              <span>标签</span>
              <select data-scene-field="tags">${tagOptions(scene.tags || "测试数据")}</select>
            </label>
            <label>
              <span>新标签</span>
              <input data-new-scene-tag placeholder="直接编写新标签" />
            </label>
          </div>
          <label><span>关键词/触发词</span><textarea data-scene-field="keywords">${escapeHtml(scene.keywords)}</textarea></label>
          <label><span>需采集数据</span><textarea data-scene-field="dataNeeded">${escapeHtml(scene.dataNeeded)}</textarea></label>
          <label><span>开发数据支撑点</span><textarea data-scene-field="devSupport">${escapeHtml(scene.devSupport)}</textarea></label>
          <div class="scene-row">
            <label><span>负责人</span><input data-scene-field="owner" value="${attr(scene.owner)}" /></label>
            <label><span>提交人</span><input value="${attr([scene.submitterName || scene.updatedByName, scene.submitterUnit || scene.updatedByUnit].filter(Boolean).join(" / "))}" readonly /></label>
          </div>
          <div class="scene-row">
            <label><span>备注</span><input data-scene-field="note" value="${attr(scene.note)}" /></label>
          </div>
          <div class="form-actions">
            <button type="button" data-save-scene="${scene.id}">保存场景修改</button>
            <button class="ghost danger" type="button" data-delete-scene="${scene.id}">删除场景</button>
          </div>
        </article>
      `,
    )
    .join("");
}

function sceneMatchesAdvancedQuery(scene) {
  const basicHit = matchesQuery(
    {
      id: scene.id,
      type: scene.type,
      target: scene.target,
      description: scene.description,
      audioName: scene.audioName,
      relatedScenes: scene.relatedScenes,
      tags: scene.tags,
      submitterName: scene.submitterName || scene.updatedByName,
      submitterPhone: scene.submitterPhone || scene.updatedByPhone,
      submitterUnit: scene.submitterUnit || scene.updatedByUnit,
      submitterRole: scene.submitterRole || scene.updatedByRole,
    },
    sceneQuery.text,
  );
  const typeHit = !sceneQuery.type || scene.type === sceneQuery.type;
  const statusHit = !sceneQuery.status || scene.status === sceneQuery.status;
  const ownerHit = matchesQuery({ owner: scene.owner }, sceneQuery.owner);
  const tagHit = matchesQuery({ tags: scene.tags }, sceneQuery.tag);
  const keywordHit = matchesQuery(
    {
      keywords: scene.keywords,
      dataNeeded: scene.dataNeeded,
      devSupport: scene.devSupport,
      note: scene.note,
      relatedScenes: scene.relatedScenes,
      tags: scene.tags,
    },
    sceneQuery.keyword,
  );
  return basicHit && typeHit && statusHit && ownerHit && tagHit && keywordHit;
}

function renderSceneQuery() {
  const body = $("#sceneQueryBody");
  if (!body) return;
  body.innerHTML = state.scenes
    .filter(sceneMatchesAdvancedQuery)
    .map(
      (scene) => `
        <tr>
          <td>${scene.id}</td>
          <td>${escapeHtml(scene.type)}</td>
          <td>${escapeHtml(scene.target)}</td>
          <td>${escapeHtml(scene.relatedScenes || "")}</td>
          <td>${escapeHtml(scene.owner)}</td>
          <td>${submitterText(scene)}</td>
          <td><span class="status ${statusClass(scene.status)}">${escapeHtml(scene.status)}</span></td>
          <td>${escapeHtml(scene.tags || "测试数据")}</td>
          <td>${escapeHtml(scene.audioName)}</td>
          <td>${escapeHtml(scene.keywords)}</td>
          <td><button class="small ghost" type="button" data-jump-scene="${scene.id}">修改</button></td>
        </tr>
      `,
    )
    .join("");
}

function attr(value = "") {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function formatFileSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN");
}

function renderKbFiles() {
  const body = $("#kbFilesBody");
  if (!body) return;
  if (!kbFiles.length) {
    body.innerHTML = `<tr><td colspan="4">还没有上传维护文件。</td></tr>`;
    return;
  }
  body.innerHTML = kbFiles
    .map((file) => {
      const isManaged = file.source !== "builtin";
      const previewDisabled = file.previewKind === "office" ? "disabled" : "";
      const previewTitle = file.previewKind === "office" ? "Office 文件请下载查看" : "预览";
      const sourceLabel = file.source === "builtin" ? "内置资料" : "维护上传";
      const deleteButton = isManaged
        ? `<button class="ghost danger" type="button" data-kb-delete="${attr(file.id)}">删除</button>`
        : "";
      return `
        <tr>
          <td>
            <div class="kb-file-name">
              <strong>${escapeHtml(file.fileName)}</strong>
              <span>${escapeHtml(sourceLabel)} · ${escapeHtml(file.extension || "")} · ${escapeHtml(file.previewKind || "")}</span>
            </div>
          </td>
          <td>${formatFileSize(file.size)}</td>
          <td>${escapeHtml(formatDateTime(file.uploadedAt))}</td>
          <td>
            <div class="kb-file-actions">
              <button class="ghost" type="button" data-kb-preview="${attr(file.id)}" ${previewDisabled}>${previewTitle}</button>
              <a href="${apiUrl(`kb-files/${encodeURIComponent(file.id)}/download`)}" download>下载</a>
              ${deleteButton}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function clearKbPreview() {
  const title = $("#kbPreviewTitle");
  const body = $("#kbPreviewBody");
  if (!title || !body) return;
  title.textContent = "文件预览";
  body.innerHTML = `<p>选择文件后可预览内置资料和维护上传文件。内置 Word、Excel、PPT 会显示抽取后的文本内容。</p>`;
}

async function loadKbFiles() {
  const body = $("#kbFilesBody");
  if (body) body.innerHTML = `<tr><td colspan="4">正在加载知识库文件…</td></tr>`;
  try {
    const res = await fetch(apiUrl("kb-files"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    kbFiles = Array.isArray(data.files) ? data.files : [];
    renderKbFiles();
  } catch (err) {
    if (body) body.innerHTML = `<tr><td colspan="4">知识库文件加载失败：${escapeHtml(err.message)}</td></tr>`;
  }
}

async function uploadKbFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("fileName", file.name);
  try {
    showToast("正在上传知识库文件…");
    const res = await fetch(apiUrl("kb-files"), { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    await loadKbFiles();
    showToast("知识库文件已上传。", "success");
  } catch (err) {
    showToast(`上传失败：${err.message}`, "error");
  }
}

async function previewKbFile(fileId) {
  const file = kbFiles.find((item) => item.id === fileId);
  if (!file) return;
  const title = $("#kbPreviewTitle");
  const body = $("#kbPreviewBody");
  if (!title || !body) return;
  title.textContent = file.fileName;
  const previewUrl = apiUrl(`kb-files/${encodeURIComponent(file.id)}/preview`);
  const downloadUrl = apiUrl(`kb-files/${encodeURIComponent(file.id)}/download`);
  if (file.previewKind === "image") {
    body.innerHTML = `<img src="${previewUrl}" alt="${attr(file.fileName)}" />`;
    return;
  }
  if (file.previewKind === "pdf") {
    body.innerHTML = `<iframe src="${previewUrl}" title="${attr(file.fileName)}"></iframe>`;
    return;
  }
  if (file.previewKind === "text") {
    body.innerHTML = `<p>正在加载文本预览…</p>`;
    try {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      body.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    } catch (err) {
      body.innerHTML = `<p>文本预览失败：${escapeHtml(err.message)}</p>`;
    }
    return;
  }
  body.innerHTML = `<p>此格式暂不支持网页内预览，请下载后查看。</p><div class="kb-file-actions"><a href="${downloadUrl}" download>下载文件</a></div>`;
}

function tagOptions(selected) {
  const tags = uniqueList(["测试数据", ...dict("sceneTags"), selected].filter(Boolean));
  return tags.map((tag) => `<option value="${attr(tag)}" ${tag === selected ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("");
}

const sceneFields = [
  ["id", "场景ID"],
  ["type", "场景类型", "selectSceneType"],
  ["target", "目标场景"],
  ["status", "状态", "selectStatus"],
  ["tags", "标签", "selectSceneTag"],
  ["newTag", "新标签"],
  ["audioName", "录音文件名"],
  ["relatedScenes", "关联场景"],
  ["owner", "负责人"],
  ["description", "场景描述", "textarea", "field-wide"],
  ["keywords", "关键词/触发词", "textarea", "field-wide"],
  ["dataNeeded", "需采集数据", "textarea", "field-wide"],
  ["devSupport", "开发数据支撑点", "textarea", "field-wide"],
  ["note", "备注", "textarea", "field-wide"],
];

const recordFields = [
  ["sceneId", "场景ID", "selectScene"],
  ["round", "轮次", "selectRound"],
  ["tags", "标签", "selectSceneTag"],
  ["time", "时间"],
  ["device", "采集设备", "selectDevice"],
  ["audioName", "录音文件名"],
  ["minutes", "录音时长(分)", "number"],
  ["userText", "用户原话/摘要", "textarea", "field-wide"],
  ["actual", "实际处理/回复", "textarea", "field-wide"],
  ["result", "穿越结果", "selectResult"],
  ["keywords", "关键词/触发词", "textarea", "field-wide"],
  ["problem", "现场问题", "textarea", "field-wide"],
  ["analysis", "大模型待分析点", "textarea", "field-wide"],
  ["devSupport", "开发数据支撑点", "textarea", "field-full"],
];

const audioFields = [
  ["sceneId", "场景ID", "selectScene"],
  ["round", "轮次", "selectRound"],
  ["tags", "标签", "selectSceneTag"],
  ["audioName", "录音文件名"],
  ["videoName", "视频文件名"],
  ["device", "采集设备", "selectDevice"],
  ["period", "时间段"],
  ["minutes", "录音时长(分)", "number"],
  ["keywords", "关键词", "textarea", "field-wide"],
  ["triggerText", "触发词/原话片段", "textarea", "field-wide"],
  ["intent", "意图标签"],
  ["speaker", "语者"],
  ["summary", "大模型分析摘要", "textarea", "field-wide"],
  ["devSupport", "开发数据支撑点", "textarea", "field-wide"],
  ["action", "建议动作", "textarea", "field-wide"],
  ["audioFile", "上传mp3文件", "file", "field-wide"],
  ["videoFile", "上传mp4视频", "videoFile", "field-wide"],
  ["status", "状态", "selectAudioStatus"],
];

const issueFields = [
  ["sceneId", "来源场景ID", "selectScene"],
  ["type", "问题类型", "selectIssueType"],
  ["tags", "标签", "selectSceneTag"],
  ["priority", "优先级", "selectPriority"],
  ["impact", "是否影响5月6日穿越", "selectImpact"],
  ["owner", "负责人"],
  ["status", "状态", "selectIssueStatus"],
  ["audioName", "关联录音文件"],
  ["problem", "现场问题", "textarea", "field-wide"],
  ["need", "需要AI/系统补什么", "textarea", "field-wide"],
  ["evidence", "数据证据/支撑点", "textarea", "field-wide"],
  ["acceptance", "验收标准", "textarea", "field-wide"],
];

const userFields = [
  ["name", "姓名"],
  ["phone", "手机号"],
  ["unit", "单位"],
  ["role", "角色", "selectRole"],
];

function createForm(form, fields, submitLabel, onSubmit) {
  form.innerHTML = fields.map(([name, label, type, className]) => fieldMarkup(name, label, type, className)).join("");
  const action = document.createElement("div");
  action.className = "form-actions";
  action.innerHTML = `
    <button type="submit">${submitLabel}</button>
    <button class="ghost" type="reset">清空</button>
    <button class="ghost" type="button" data-cancel-edit hidden>取消修改</button>
  `;
  form.append(action);
  const submitButton = form.querySelector('button[type="submit"]');
  const resetButton = form.querySelector('button[type="reset"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await onSubmit(data);
      if (result === false) return;
      form.dataset.skipResetConfirm = "1";
      form.reset();
      delete form.dataset.skipResetConfirm;
      form.dataset.editingId = "";
      form.querySelector("[data-cancel-edit]").hidden = true;
    } catch (err) {
      showToast(`提交失败：${err.message}`, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
  resetButton.addEventListener("click", (event) => {
    if (form.dataset.skipResetConfirm === "1") return;
    if (!doubleConfirm("清空当前表单？", "已填写但未提交的内容会被清空。")) {
      event.preventDefault();
    }
  });
  form.addEventListener("reset", () => {
    form.dataset.editingId = "";
    form.querySelector("[data-cancel-edit]").hidden = true;
  });
  form.querySelector("[data-cancel-edit]").addEventListener("click", () => {
    form.reset();
  });
}

function fieldMarkup(name, label, type = "text", className = "") {
  if (type === "textarea") {
    return `<label class="${className}"><span>${label}</span><textarea name="${name}"></textarea></label>`;
  }
  if (type === "file") {
    return `<label class="${className}"><span>${label}</span><input name="${name}" type="file" accept="audio/mpeg,audio/mp3,.mp3" /></label>`;
  }
  if (type === "videoFile") {
    return `<label class="${className}"><span>${label}</span><input name="${name}" type="file" accept="video/mp4,.mp4" /></label>`;
  }
  if (type === "number") {
    return `<label class="${className}"><span>${label}</span><input name="${name}" type="number" min="0" step="1" /></label>`;
  }
  const selectOptions = {
    selectScene: state.scenes.map((scene) => scene.id),
    selectSceneType: dict("sceneTypes"),
    selectStatus: dict("statuses"),
    selectRound: dict("rounds"),
    selectDevice: dict("devices"),
    selectResult: dict("results"),
    selectAudioStatus: dict("audioStatuses"),
    selectIssueType: dict("issueTypes"),
    selectPriority: dict("priorities"),
    selectImpact: dict("impact"),
    selectIssueStatus: dict("issueStatuses"),
    selectSceneTag: dict("sceneTags"),
    selectRole: dict("roles"),
  }[type];
  if (selectOptions) {
    return `<label class="${className}"><span>${label}</span><select name="${name}">${selectOptions
      .map((option) => `<option>${option}</option>`)
      .join("")}</select></label>`;
  }
  return `<label class="${className}"><span>${label}</span><input name="${name}" /></label>`;
}

function sceneFromForm(data) {
  const id = String(data.id || "").trim().toUpperCase();
  const tag = String(data.newTag || data.tags || "测试数据").trim();
  return {
    id,
    type: data.type || dict("sceneTypes")[0] || "",
    target: data.target || "",
    description: data.description || "",
    audioName: normalizeMp3(data.audioName || `${id}_01.mp3`),
    relatedScenes: data.relatedScenes || "",
    keywords: data.keywords || "",
    dataNeeded: data.dataNeeded || "",
    devSupport: data.devSupport || "",
    owner: data.owner || "",
    status: data.status || dict("statuses")[0] || "",
    tags: tag || "测试数据",
    note: data.note || "",
    submitterName: state.currentUser?.name || "",
    submitterPhone: state.currentUser?.phone || "",
    submitterUnit: state.currentUser?.unit || "",
    submitterRole: state.currentUser?.role || "",
    updatedByName: state.currentUser?.name || "",
    updatedByPhone: state.currentUser?.phone || "",
    updatedByUnit: state.currentUser?.unit || "",
    updatedByRole: state.currentUser?.role || "",
  };
}

function recordFromForm(data) {
  const scene = getScene(data.sceneId);
  return {
    id: data.id || `LOG-${String(state.records.length + 1).padStart(3, "0")}`,
    time: data.time || "",
    sceneId: data.sceneId,
    round: data.round || "1",
    tags: data.tags || scene.tags || "测试数据",
    target: scene.target,
    description: scene.description,
    device: data.device || "录音卡",
    audioName: normalizeMp3(data.audioName || `${scene.id}_${data.round || 1}.mp3`),
    minutes: data.minutes || "",
    userText: data.userText || "",
    actual: data.actual || "",
    expected: scene.devSupport,
    result: data.result || "待确认",
    keywords: data.keywords || scene.keywords,
    problem: data.problem || "",
    analysis: data.analysis || "",
    devSupport: data.devSupport || scene.devSupport,
    recorder: "",
    ...currentUserFields(),
    note: "",
  };
}

function audioFromForm(data) {
  const scene = getScene(data.sceneId);
  const uploadedFile = data.audioFile && data.audioFile.size ? data.audioFile : null;
  const uploadedVideo = data.videoFile && data.videoFile.size ? data.videoFile : null;
  const defaultMediaBase = `${scene.id}_${data.round || 1}`;
  return {
    id: data.id || `AUD-${String(state.audio.length + 1).padStart(3, "0")}`,
    audioName: normalizeMp3(data.audioName || uploadedFile?.name || `${defaultMediaBase}.mp3`),
    videoName: normalizeMp4(data.videoName || uploadedVideo?.name || `${defaultMediaBase}.mp4`),
    sceneId: data.sceneId,
    round: data.round || "1",
    tags: data.tags || scene.tags || "测试数据",
    target: scene.target,
    device: data.device || "录音卡",
    period: data.period || "",
    minutes: data.minutes || "",
    keywords: data.keywords || scene.keywords,
    triggerText: data.triggerText || "",
    intent: data.intent || "",
    speaker: data.speaker || "用户/一线/AI",
    summary: data.summary || "",
    devSupport: data.devSupport || scene.devSupport,
    action: data.action || "",
    status: data.status || "待上传",
    hasAudioFile: uploadedFile ? true : Boolean(data.hasAudioFile),
    audioFileSize: data.audioFileSize || "",
    audioUploadedAt: data.audioUploadedAt || "",
    serverVerifiedAt: data.serverVerifiedAt || "",
    serverChecksum: data.serverChecksum || "",
    hasVideoFile: uploadedVideo ? true : Boolean(data.hasVideoFile),
    videoFileSize: data.videoFileSize || "",
    videoUploadedAt: data.videoUploadedAt || "",
    videoServerVerifiedAt: data.videoServerVerifiedAt || "",
    videoServerChecksum: data.videoServerChecksum || "",
    ...currentUserFields(),
    note: "",
  };
}

function issueFromForm(data) {
  const scene = getScene(data.sceneId);
  return {
    id: data.id || `ISS-${String(state.issues.length + 1).padStart(3, "0")}`,
    sceneId: data.sceneId,
    target: scene.target,
    tags: data.tags || scene.tags || "测试数据",
    type: data.type || "规则缺失",
    problem: data.problem || "",
    need: data.need || "",
    evidence: data.evidence || "",
    priority: data.priority || "P1-本周解决",
    impact: data.impact || "否",
    owner: data.owner || "",
    status: data.status || "待开发",
    audioName: normalizeMp3(data.audioName || ""),
    acceptance: data.acceptance || "",
    ...currentUserFields(),
    note: "",
  };
}

function normalizeMp3(fileName) {
  const value = String(fileName || "").trim();
  if (!value) return "";
  return value.replace(/\.(wav|m4a|mp4|aac)$/i, ".mp3").replace(/\.mp3$/i, ".mp3");
}

function normalizeMp4(fileName) {
  const value = String(fileName || "").trim();
  if (!value) return "";
  return value.replace(/\.(mov|m4v|avi|mkv|webm)$/i, ".mp4").replace(/\.mp4$/i, ".mp4");
}

function renderRecords() {
  $("#recordsBody").innerHTML = state.records
    .filter((record) => matchesQuery(record, filters.records))
    .map(
      (record) => `
        <tr data-record-id="${record.id}">
          <td>${record.id}</td>
          <td>${record.sceneId}<br />${escapeHtml(record.target)}</td>
          <td>${record.round}</td>
          <td>${escapeHtml(record.audioName)}</td>
          <td>${record.minutes || ""}</td>
          <td><span class="status ${statusClass(record.result)}">${record.result}</span></td>
          <td>${escapeHtml(record.tags || "测试数据")}</td>
          <td>${escapeHtml(record.keywords)}</td>
          <td>${escapeHtml(record.devSupport)}</td>
          <td>${submitterText(record)}</td>
          <td class="row-actions">
            <button class="small ghost" type="button" data-edit-record="${record.id}">修改</button>
            <button class="small ghost danger" type="button" data-delete-record="${record.id}">删除</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderAudio() {
  $("#audioBody").innerHTML = state.audio
    .filter((audio) => matchesQuery(audio, filters.audio))
    .map(
      (audio) => `
        <tr data-audio-id="${audio.id}">
          <td>${audio.id}</td>
          <td>${escapeHtml(audio.audioName)}</td>
          <td class="audio-cell" data-audio-player="${audio.id}">
            ${audio.hasAudioFile ? '<span class="audio-loading">加载中</span>' : '<span class="muted-text">未上传</span>'}
          </td>
          <td>${escapeHtml(audio.videoName || "")}</td>
          <td class="video-cell" data-video-player="${audio.id}">
            ${audio.hasVideoFile ? '<span class="audio-loading">加载中</span>' : '<span class="muted-text">未上传</span>'}
          </td>
          <td>${audio.sceneId}<br />${escapeHtml(audio.target)}</td>
          <td>${audio.round}</td>
          <td>${escapeHtml(audio.keywords)}</td>
          <td><span class="status ${statusClass(audio.status)}">${audio.status}</span></td>
          <td>${escapeHtml(audio.tags || "测试数据")}</td>
          <td>${escapeHtml(audio.devSupport)}</td>
          <td>${submitterText(audio)}</td>
          <td class="row-actions">
            <button class="small ghost" type="button" data-edit-audio="${audio.id}">修改</button>
            <button class="small ghost danger" type="button" data-delete-audio="${audio.id}">删除</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function hydrateAudioPlayers() {
  // Audio is streamed straight from the shared backend; no IndexedDB step.
  const cells = $$("[data-audio-player]");
  cells.forEach((cell) => {
    const id = cell.dataset.audioPlayer;
    const audio = state.audio.find((item) => item.id === id);
    if (!audio?.hasAudioFile) return;
    const url = getAudioUrl(id);
    cell.innerHTML = `
      <audio controls preload="metadata" src="${url}"></audio>
      <a class="download-link" href="${url}" download="${attr(audio.audioName || `${id}.mp3`)}">下载</a>
    `;
  });
  const videoCells = $$("[data-video-player]");
  videoCells.forEach((cell) => {
    const id = cell.dataset.videoPlayer;
    const audio = state.audio.find((item) => item.id === id);
    if (!audio?.hasVideoFile) return;
    const url = getVideoUrl(id);
    cell.innerHTML = `
      <video controls preload="metadata" src="${url}"></video>
      <a class="download-link" href="${url}" download="${attr(audio.videoName || `${id}.mp4`)}">下载</a>
    `;
  });
}

function renderIssues() {
  $("#issuesBody").innerHTML = state.issues
    .filter((issue) => matchesQuery(issue, filters.issues))
    .map(
      (issue) => `
        <tr data-issue-id="${issue.id}">
          <td>${issue.id}</td>
          <td>${escapeHtml(issue.target)}</td>
          <td>${issue.type}</td>
          <td>${issue.priority}</td>
          <td>${issue.impact}</td>
          <td><span class="status ${statusClass(issue.status)}">${issue.status}</span></td>
          <td>${escapeHtml(issue.tags || "测试数据")}</td>
          <td>${escapeHtml(issue.audioName)}</td>
          <td>${submitterText(issue)}</td>
          <td class="row-actions">
            <button class="small ghost" type="button" data-edit-issue="${issue.id}">修改</button>
            <button class="small ghost danger" type="button" data-delete-issue="${issue.id}">删除</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderDictionaries() {
  const grid = $("#dictionaryGrid");
  if (!grid) return;
  grid.innerHTML = Object.entries(dictionaryLabels)
    .map(
      ([key, label]) => `
        <label class="dictionary-card">
          <span>${label}</span>
          <textarea data-dictionary-key="${key}">${escapeHtml(dict(key).join("\n"))}</textarea>
        </label>
      `,
    )
    .join("");
}

function userKey(user) {
  return user.phone || `${user.name}-${user.unit}`;
}

function renderUsers() {
  const body = $("#usersBody");
  if (!body) return;
  body.innerHTML = state.users
    .map(
      (user) => `
        <tr>
          <td>${escapeHtml(user.name)}</td>
          <td>${escapeHtml(user.phone)}</td>
          <td>${escapeHtml(user.unit)}</td>
          <td>${escapeHtml(user.role)}</td>
          <td>${user.loginAt ? escapeHtml(new Date(user.loginAt).toLocaleString("zh-CN")) : ""}</td>
          <td class="row-actions">
            <button class="small ghost" type="button" data-edit-user="${attr(userKey(user))}">修改</button>
            <button class="small ghost danger" type="button" data-delete-user="${attr(userKey(user))}">删除</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderQuerySelects() {
  const typeSelect = $("#sceneTypeQuery");
  const statusSelect = $("#sceneStatusQuery");
  if (!typeSelect || !statusSelect) return;
  const selectedType = typeSelect.value;
  const selectedStatus = statusSelect.value;
  typeSelect.innerHTML = `<option value="">全部类型</option>${dict("sceneTypes")
    .map((option) => `<option value="${attr(option)}">${escapeHtml(option)}</option>`)
    .join("")}`;
  statusSelect.innerHTML = `<option value="">全部状态</option>${dict("statuses")
    .map((option) => `<option value="${attr(option)}">${escapeHtml(option)}</option>`)
    .join("")}`;
  typeSelect.value = selectedType;
  statusSelect.value = selectedStatus;
}

function renderLoginRoleOptions() {
  const roleSelect = $("#loginForm")?.elements.role;
  if (!roleSelect) return;
  const selected = roleSelect.value || state.currentUser?.role || "";
  roleSelect.innerHTML = dict("roles")
    .map((role) => `<option value="${attr(role)}">${escapeHtml(role)}</option>`)
    .join("");
  if (selected && dict("roles").includes(selected)) roleSelect.value = selected;
}

function loginUser(user) {
  state.currentUser = {
    ...EMPTY_USER,
    ...user,
    loginAt: new Date().toISOString(),
  };
  const phone = state.currentUser.phone;
  const existing = state.users.find((item) => {
    if (phone && item.phone && item.phone === phone) return true;
    return item.name === state.currentUser.name && (item.unit || "") === (state.currentUser.unit || "");
  });
  if (existing) {
    Object.assign(existing, state.currentUser);
  } else {
    state.users.push({ ...state.currentUser });
  }
  saveState();
}

function updateForm(form, item) {
  Object.entries(item).forEach(([name, value]) => {
    const field = form.elements[name];
    if (field) field.value = value ?? "";
  });
  form.dataset.editingId = item.id || userKey(item);
  form.querySelector("[data-cancel-edit]").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function upsertById(list, id, item) {
  const index = list.findIndex((entry) => entry.id === id);
  if (index === -1) {
    list.push(item);
  } else {
    list[index] = { ...list[index], ...item, id };
  }
}

function deleteById(list, id) {
  const index = list.findIndex((entry) => entry.id === id);
  if (index !== -1) list.splice(index, 1);
}

function userFromForm(data) {
  return {
    name: String(data.name || "").trim(),
    phone: String(data.phone || "").trim(),
    unit: String(data.unit || "").trim(),
    role: String(data.role || "").trim(),
    loginAt: "",
  };
}

function upsertUser(editingKey, user) {
  if (!user.name || !user.phone || !user.unit || !user.role) {
    showToast("请把姓名、手机号、单位、角色填写完整。", "error");
    return false;
  }
  const key = editingKey || userKey(user);
  const index = state.users.findIndex((item) => userKey(item) === key || item.name === user.name || item.phone === user.phone);
  if (index === -1) {
    state.users.push(user);
  } else {
    state.users[index] = { ...state.users[index], ...user };
  }
  return true;
}

function deleteUserByKey(key) {
  const index = state.users.findIndex((user) => userKey(user) === key);
  if (index !== -1) state.users.splice(index, 1);
}

function saveSceneFromForm(data) {
  const scene = sceneFromForm(data);
  if (!scene.id) {
    showToast("请先填写场景ID。", "error");
    return false;
  }
  addSceneTag(scene.tags);
  const existingId = $("#sceneForm").dataset.editingId;
  const targetId = existingId || scene.id;
  upsertById(state.scenes, targetId, scene);
  syncLinkedSceneData(scene.id);
  return saveState(existingId ? "场景修改已提交并同步。" : "新增场景已提交并同步。");
}

function syncLinkedSceneData(sceneId) {
  const scene = state.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  state.records.forEach((record) => {
    if (record.sceneId === sceneId) {
      record.target = scene.target;
      record.description = scene.description;
      record.expected = scene.devSupport;
    }
  });
  state.audio.forEach((audio) => {
    if (audio.sceneId === sceneId) audio.target = scene.target;
  });
  state.issues.forEach((issue) => {
    if (issue.sceneId === sceneId) issue.target = scene.target;
  });
}

function saveSceneFromCard(sceneId) {
  const card = document.querySelector(`[data-scene-card="${sceneId}"]`);
  const scene = state.scenes.find((item) => item.id === sceneId);
  if (!card || !scene) return;
  card.querySelectorAll("[data-scene-field]").forEach((field) => {
    const key = field.dataset.sceneField;
    scene[key] = key === "audioName" ? normalizeMp3(field.value) : field.value;
  });
  const newTag = card.querySelector("[data-new-scene-tag]")?.value.trim();
  if (newTag) scene.tags = newTag;
  addSceneTag(scene.tags);
  scene.submitterName = state.currentUser?.name || "";
  scene.submitterPhone = state.currentUser?.phone || "";
  scene.submitterUnit = state.currentUser?.unit || "";
  scene.submitterRole = state.currentUser?.role || "";
  scene.updatedByName = state.currentUser?.name || "";
  scene.updatedByPhone = state.currentUser?.phone || "";
  scene.updatedByUnit = state.currentUser?.unit || "";
  scene.updatedByRole = state.currentUser?.role || "";
  syncLinkedSceneData(sceneId);
  return saveState(`场景 ${sceneId} 修改已提交并同步。`);
}

function addSceneTag(tag) {
  const value = String(tag || "").trim();
  if (!value) return;
  state.dictionaries.sceneTags = uniqueList([...(state.dictionaries.sceneTags || []), value]);
}

function saveDictionaries() {
  $("#dictionaryGrid").querySelectorAll("[data-dictionary-key]").forEach((field) => {
    state.dictionaries[field.dataset.dictionaryKey] = field.value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  });
  return saveState("字典表已提交并同步。");
}

function syncFormOptions() {
  const optionMap = {
    sceneId: state.scenes.map((scene) => scene.id),
    round: dict("rounds"),
    device: dict("devices"),
    result: dict("results"),
    priority: dict("priorities"),
    impact: dict("impact"),
  };
  const formSpecific = new Map([
    ["sceneForm:type", dict("sceneTypes")],
    ["sceneForm:status", dict("statuses")],
    ["sceneForm:tags", dict("sceneTags")],
    ["recordForm:tags", dict("sceneTags")],
    ["audioForm:tags", dict("sceneTags")],
    ["issueForm:tags", dict("sceneTags")],
    ["issueForm:type", dict("issueTypes")],
    ["userForm:role", dict("roles")],
    ["audioForm:status", dict("audioStatuses")],
    ["issueForm:status", dict("issueStatuses")],
  ]);
  ["sceneForm", "recordForm", "audioForm", "issueForm"].forEach((formId) => {
    const form = $(`#${formId}`);
    if (!form) return;
    Array.from(form.elements).forEach((field) => {
      if (field.tagName !== "SELECT") return;
      const previous = field.value;
      const choices = formSpecific.get(`${formId}:${field.name}`) || optionMap[field.name];
      if (!choices) return;
      field.innerHTML = choices.map((option) => `<option>${escapeHtml(option)}</option>`).join("");
      if (choices.includes(previous)) field.value = previous;
    });
  });
  renderQuerySelects();
  renderLoginRoleOptions();
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function exportJson() {
  download(`aicp-sop-training-${Date.now()}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8");
}

function exportCsv() {
  const rows = [
    ["类型", "ID", "场景ID", "目标场景", "关联场景", "录音文件", "视频文件", "标签", "关键词", "开发支撑点", "状态/结果", "提交人", "手机号", "单位", "角色", "本地音频", "本地视频"],
    ...state.scenes.map((item) => [
      "场景清单",
      item.id,
      item.id,
      item.target,
      item.relatedScenes || "",
      item.audioName,
      "",
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.status,
      ...submitterValues(item),
      "",
      "",
    ]),
    ...state.records.map((item) => [
      "现场记录",
      item.id,
      item.sceneId,
      item.target,
      "",
      item.audioName,
      "",
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.result,
      ...submitterValues(item),
      "",
      "",
    ]),
    ...state.audio.map((item) => [
      "录音关键词",
      item.id,
      item.sceneId,
      item.target,
      "",
      item.audioName,
      item.videoName || "",
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.status,
      ...submitterValues(item),
      item.hasAudioFile ? "已上传" : "未上传",
      item.hasVideoFile ? "已上传" : "未上传",
    ]),
    ...state.issues.map((item) => [
      "问题需求",
      item.id,
      item.sceneId,
      item.target,
      "",
      item.audioName,
      "",
      item.tags || "测试数据",
      item.problem,
      item.evidence,
      item.status,
      ...submitterValues(item),
      "",
      "",
    ]),
    ...state.users.map((item) => [
      "人员列表",
      userKey(item),
      "",
      item.name,
      "",
      "",
      "",
      "",
      item.phone,
      item.unit,
      item.loginAt || "",
      item.name,
      item.phone,
      item.unit,
      item.role,
      "",
      "",
    ]),
    ...Object.entries(state.dailySchedules || {}).flatMap(([date, schedule]) =>
      (schedule || []).map((row, index) => [
        "穿越日程",
        `${date}-${index + 1}`,
        row[2] || "",
        row[3] || "",
        "",
        "",
        "",
        date,
        [row[0], row[1], row[4], row[5], row[6]].filter(Boolean).join(";"),
        row[6] || "",
        row[7] || "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    ),
    ...Object.entries(state.dictionaries).map(([key, values]) => [
      "字典表",
      key,
      "",
      dictionaryLabels[key] || key,
      "",
      "",
      "",
      "",
      values.join(";"),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]),
  ];
  download(`aicp-sop-training-${Date.now()}.csv`, `\ufeff${toCsv(rows)}`, "text/csv;charset=utf-8");
}

function initNav() {
  const showView = (name) => {
    $$(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === name));
    $$("[data-view-link]").forEach((link) => link.classList.toggle("is-active", link.dataset.viewLink === name));
  };
  $$("[data-view-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const view = link.dataset.viewLink;
      history.replaceState(null, "", `#${view}`);
      showView(view);
    });
  });
  const initial = location.hash.replace("#", "") || "dashboard";
  showView(initial);
}

function initMindmapLightbox() {
  const lightbox = $("#mindmapLightbox");
  const image = $("#mindmapLightboxImage");
  const title = $("#mindmapLightboxTitle");
  const closeBtn = $("#mindmapLightboxClose");
  if (!lightbox || !image || !title || !closeBtn) return;

  const close = () => {
    lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
    image.removeAttribute("src");
    image.alt = "";
  };

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-zoom-src]");
    if (!trigger) return;
    const src = trigger.dataset.zoomSrc;
    const zoomTitle = trigger.dataset.zoomTitle || "脑图大图";
    if (!src) return;
    title.textContent = zoomTitle;
    image.src = src;
    image.alt = `${zoomTitle}大图`;
    lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    closeBtn.focus();
  });

  closeBtn.addEventListener("click", close);
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !lightbox.hidden) close();
  });
}

function initKbTabs() {
  const tabs = $$(".kb-tab");
  const panes = $$("[data-kb-pane]");
  if (!tabs.length || !panes.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.kbTab;
      tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      panes.forEach((p) => p.classList.toggle("is-active", p.dataset.kbPane === target));
    });
  });
}

function initEvents() {
  initMindmapLightbox();
  initKbTabs();

  $("#loginForm").addEventListener("click", (event) => {
    const name = event.target.dataset.quickUser;
    if (!name) return;
    const user = state.users.find((item) => item.name === name) || defaultUsers.find((item) => item.name === name);
    if (user) loginUser(user);
  });

  $("#loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    loginUser({
      name: String(data.name || "").trim(),
      phone: String(data.phone || "").trim(),
      unit: String(data.unit || "").trim(),
      role: String(data.role || "").trim(),
    });
  });

  $("#switchUserBtn").addEventListener("click", () => {
    const form = $("#loginForm");
    form.elements.name.value = state.currentUser?.name || "";
    form.elements.phone.value = state.currentUser?.phone || "";
    form.elements.unit.value = state.currentUser?.unit || "";
    form.elements.role.value = state.currentUser?.role || dict("roles")[0] || "";
    document.body.classList.add("login-open");
    $("#loginScreen").hidden = false;
  });

  createForm($("#sceneForm"), sceneFields, "保存场景", (data) => {
    return saveSceneFromForm(data);
  });

  createForm($("#recordForm"), recordFields, "保存现场记录", (data) => {
    const editingId = $("#recordForm").dataset.editingId;
    const record = recordFromForm({ ...data, id: editingId });
    upsertById(state.records, editingId, record);
    if (!editingId && !state.audio.some((audio) => audio.audioName === record.audioName)) {
      state.audio.push(audioFromForm({ ...data, audioName: record.audioName, keywords: record.keywords }));
    }
    return saveState(editingId ? "现场记录修改已提交并同步。" : "现场记录已提交并同步。");
  });

  createForm($("#audioForm"), audioFields, "保存录音关键词", async (data) => {
    const editingId = $("#audioForm").dataset.editingId;
    const previous = state.audio.find((item) => item.id === editingId);
    const audio = audioFromForm({
      ...data,
      id: editingId,
      hasAudioFile: previous?.hasAudioFile || false,
      audioFileSize: previous?.audioFileSize || "",
      audioUploadedAt: previous?.audioUploadedAt || "",
      serverVerifiedAt: previous?.serverVerifiedAt || "",
      serverChecksum: previous?.serverChecksum || "",
      hasVideoFile: previous?.hasVideoFile || false,
      videoFileSize: previous?.videoFileSize || "",
      videoUploadedAt: previous?.videoUploadedAt || "",
      videoServerVerifiedAt: previous?.videoServerVerifiedAt || "",
      videoServerChecksum: previous?.videoServerChecksum || "",
    });
    if (data.audioFile?.size) {
      const stored = await saveAudioBlob(audio.id, data.audioFile);
      audio.hasAudioFile = true;
      audio.audioFileSize = stored?.size || data.audioFile.size;
      audio.audioUploadedAt = new Date().toISOString();
      audio.serverVerifiedAt = new Date().toISOString();
      audio.serverChecksum = stored?.checksum || "";
      if (!data.status || data.status === "待上传") audio.status = "已上传";
    }
    if (data.videoFile?.size) {
      const storedVideo = await saveVideoBlob(audio.id, data.videoFile);
      audio.hasVideoFile = true;
      audio.videoFileSize = storedVideo?.size || data.videoFile.size;
      audio.videoUploadedAt = new Date().toISOString();
      audio.videoServerVerifiedAt = new Date().toISOString();
      audio.videoServerChecksum = storedVideo?.checksum || "";
    }
    upsertById(state.audio, editingId, audio);
    const uploadedMessage = data.audioFile?.size ? "录音文件已上传服务器并校验通过。" : "";
    const videoMessage = data.videoFile?.size ? "视频文件已上传服务器并校验通过。" : "";
    return saveState(`${editingId ? "录音关键词修改已提交并同步。" : "录音关键词已提交并同步。"}${uploadedMessage}${videoMessage}`);
  });

  createForm($("#issueForm"), issueFields, "保存问题需求", (data) => {
    const editingId = $("#issueForm").dataset.editingId;
    upsertById(state.issues, editingId, issueFromForm({ ...data, id: editingId }));
    return saveState(editingId ? "问题需求修改已提交并同步。" : "问题需求已提交并同步。");
  });

  createForm($("#userForm"), userFields, "保存人员", (data) => {
    const editingKey = $("#userForm").dataset.editingId;
    const user = userFromForm(data);
    if (!upsertUser(editingKey, user)) return false;
    return saveState(editingKey ? "人员信息修改已提交并同步。" : "新增人员已提交并同步。");
  });

  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#saveDictionaryBtn").addEventListener("click", () => {
    saveDictionaries();
  });
  $("#resetBtn").addEventListener("click", async () => {
    if (!doubleConfirm("重置共享数据？", "这会清空服务器上所有人填写的内容和录音文件，且不可恢复。")) return;
    try {
      const res = await fetch(apiUrl("reset"), { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stateVersion = 0;
      await hydrateFromServer();
      await loadKbFiles();
      showSyncStatus("ok");
      showToast("共享数据已重置。", "success");
    } catch (err) {
      showToast(`重置失败：${err.message}`, "error");
    }
  });

  $("#kbFileInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await uploadKbFile(file);
    event.target.value = "";
  });

  $("#refreshKbFilesBtn")?.addEventListener("click", () => {
    loadKbFiles();
  });

  $("#clearKbPreviewBtn")?.addEventListener("click", clearKbPreview);

  $("#kbFilesBody")?.addEventListener("click", async (event) => {
    const previewId = event.target.dataset.kbPreview;
    if (previewId) {
      await previewKbFile(previewId);
      return;
    }
    const deleteId = event.target.dataset.kbDelete;
    if (deleteId) {
      const file = kbFiles.find((item) => item.id === deleteId);
      if (!file || !doubleConfirm(`删除知识库文件 ${file.fileName}？`, "删除后需要重新上传。")) return;
      try {
        const res = await fetch(apiUrl(`kb-files/${encodeURIComponent(deleteId)}`), { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        clearKbPreview();
        await loadKbFiles();
        showToast("知识库文件已删除。", "success");
      } catch (err) {
        showToast(`删除失败：${err.message}`, "error");
      }
    }
  });

  $("#syncPill")?.addEventListener("click", async () => {
    try {
      await hydrateFromServer();
      showSyncStatus("ok");
    } catch (err) {
      showSyncStatus("error", `刷新失败：${err.message}`);
    }
  });

  [
    ["#scheduleSearch", "schedule", renderSchedule],
    ["#sceneCardSearch", "sceneCards", renderScenes],
    ["#recordSearch", "records", renderRecords],
    ["#audioSearch", "audio", renderAudio],
    ["#issueSearch", "issues", renderIssues],
  ].forEach(([selector, key, render]) => {
    $(selector).addEventListener("input", (event) => {
      filters[key] = event.target.value;
      render();
    });
  });

  $("#scheduleDateTabs")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-schedule-tab]");
    if (!target) return;
    const value = target.dataset.scheduleTab;
    if (!value || value === activeScheduleDate) return;
    activeScheduleDate = value;
    if (value !== ALL_SCHEDULE_DATES) getScheduleForDate(value);
    renderSchedule();
  });

  [
    ["#sceneSearch", "text"],
    ["#sceneTypeQuery", "type"],
    ["#sceneStatusQuery", "status"],
    ["#sceneOwnerQuery", "owner"],
    ["#sceneTagQuery", "tag"],
    ["#sceneKeywordQuery", "keyword"],
  ].forEach(([selector, key]) => {
    $(selector).addEventListener("input", (event) => {
      sceneQuery[key] = event.target.value;
      renderSceneQuery();
    });
  });

  $("#clearSceneQueryBtn").addEventListener("click", () => {
    Object.keys(sceneQuery).forEach((key) => {
      sceneQuery[key] = "";
    });
    ["#sceneSearch", "#sceneTypeQuery", "#sceneStatusQuery", "#sceneOwnerQuery", "#sceneTagQuery", "#sceneKeywordQuery"].forEach((selector) => {
      $(selector).value = "";
    });
    renderSceneQuery();
  });

  $("#scheduleBody").addEventListener("change", (event) => {
    const index = event.target.dataset.scheduleIndex;
    const date = event.target.dataset.scheduleDate || activeScheduleDate;
    if (index !== undefined && date && date !== ALL_SCHEDULE_DATES) {
      const row = getScheduleForDate(date)[Number(index)];
      if (Array.isArray(row)) {
        row[7] = event.target.value;
      } else if (row) {
        row.status = event.target.value;
      }
      syncLegacyDailyFields(date);
      saveState(`${date} 日程状态已更新并同步。`);
    }
  });

  $("#sceneGrid").addEventListener("click", (event) => {
    const sceneId = event.target.dataset.saveScene;
    if (sceneId) saveSceneFromCard(sceneId);
    const deleteSceneId = event.target.dataset.deleteScene;
    if (deleteSceneId && doubleConfirm(`删除场景 ${deleteSceneId}？`, "已有现场记录、录音和问题不会自动删除，请确认是否继续。")) {
      deleteById(state.scenes, deleteSceneId);
      saveState(`场景 ${deleteSceneId} 已删除并同步。`);
    }
  });

  $("#sceneQueryBody").addEventListener("click", (event) => {
    const sceneId = event.target.dataset.jumpScene;
    if (!sceneId) return;
    filters.sceneCards = sceneId;
    $("#sceneCardSearch").value = sceneId;
    renderScenes();
    requestAnimationFrame(() => {
      document.querySelector(`[data-scene-card="${sceneId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  $("#recordsBody").addEventListener("click", (event) => {
    const recordId = event.target.dataset.editRecord;
    const record = state.records.find((item) => item.id === recordId);
    if (record) updateForm($("#recordForm"), record);
    const deleteRecordId = event.target.dataset.deleteRecord;
    if (deleteRecordId && doubleConfirm(`删除现场记录 ${deleteRecordId}？`, "删除后需要重新填写或从备份恢复。")) {
      deleteById(state.records, deleteRecordId);
      saveState(`现场记录 ${deleteRecordId} 已删除并同步。`);
    }
  });

  $("#audioBody").addEventListener("click", async (event) => {
    const audioId = event.target.dataset.editAudio;
    const audio = state.audio.find((item) => item.id === audioId);
    if (audio) updateForm($("#audioForm"), audio);
    const deleteAudioId = event.target.dataset.deleteAudio;
    if (deleteAudioId && doubleConfirm(`删除录音记录 ${deleteAudioId}？`, "关联的 mp3 文件也会一并删除。")) {
      deleteById(state.audio, deleteAudioId);
      await deleteAudioBlob(deleteAudioId);
      await deleteVideoBlob(deleteAudioId);
      saveState(`录音记录 ${deleteAudioId} 已删除并同步。`);
    }
  });

  $("#issuesBody").addEventListener("click", (event) => {
    const issueId = event.target.dataset.editIssue;
    const issue = state.issues.find((item) => item.id === issueId);
    if (issue) updateForm($("#issueForm"), issue);
    const deleteIssueId = event.target.dataset.deleteIssue;
    if (deleteIssueId && doubleConfirm(`删除问题 ${deleteIssueId}？`, "删除后需要重新填写或从备份恢复。")) {
      deleteById(state.issues, deleteIssueId);
      saveState(`问题 ${deleteIssueId} 已删除并同步。`);
    }
  });

  $("#usersBody").addEventListener("click", (event) => {
    const editUserKey = event.target.dataset.editUser;
    const user = state.users.find((item) => userKey(item) === editUserKey);
    if (user) updateForm($("#userForm"), user);
    const deleteUserKey = event.target.dataset.deleteUser;
    const deleteUser = state.users.find((item) => userKey(item) === deleteUserKey);
    if (deleteUserKey && deleteUser && doubleConfirm(`删除人员 ${deleteUser.name}？`, "删除后该人员不会出现在快捷登录和人员列表中。")) {
      deleteUserByKey(deleteUserKey);
      saveState(`人员 ${deleteUser.name} 已删除并同步。`);
    }
  });

  $("#addSceneBtn").addEventListener("click", () => $("#sceneForm").scrollIntoView({ behavior: "smooth" }));
  $("#addRecordBtn").addEventListener("click", () => $("#recordForm").scrollIntoView({ behavior: "smooth" }));
  $("#addAudioBtn").addEventListener("click", () => $("#audioForm").scrollIntoView({ behavior: "smooth" }));
  $("#addIssueBtn").addEventListener("click", () => $("#issueForm").scrollIntoView({ behavior: "smooth" }));
  $("#addUserBtn").addEventListener("click", () => $("#userForm").scrollIntoView({ behavior: "smooth" }));
}

async function bootstrap() {
  initNav();
  initEvents();
  renderQuerySelects();
  renderLoginRoleOptions();
  renderAll();
  showSyncStatus("saving", "加载中…");
  try {
    await hydrateFromServer();
    await loadKbFiles();
    showSyncStatus("ok");
  } catch (err) {
    console.error(err);
    showSyncStatus("offline", "无法连接服务器，先以本地模式工作。");
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollForUpdates, POLL_INTERVAL_MS);
}

bootstrap();
