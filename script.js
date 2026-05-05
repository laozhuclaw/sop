// --- shared backend integration --------------------------------------------
// All structured state lives on the server (see server/server.js).
// Only the per-browser current user is kept in localStorage so each device
// stays "logged in" across reloads.
const API_BASE = "api";
const LOCAL_USER_KEY = "aicp-sop-current-user-v1";
let stateVersion = 0;
let lastSyncedAt = "";
let saveQueue = Promise.resolve();
let pollTimer = null;
const POLL_INTERVAL_MS = 4000;

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

const defaultUsers = [
  { name: "蔡俊", phone: "18500039693", unit: "好活", role: "开发", loginAt: "" },
  { name: "张明昊", phone: "18662678967", unit: "好活", role: "开发", loginAt: "" },
  { name: "王子寅", phone: "13372152239", unit: "好活", role: "开发", loginAt: "" },
  { name: "邵新", phone: "待补充", unit: "苏州移动 网络部", role: "网络", loginAt: "" },
  { name: "AI", phone: "19900000000", unit: "AICP", role: "AI", loginAt: "" },
];

const initialDictionaries = {
  sceneTypes: ["基本保障", "服务", "随销", "异常升级"],
  statuses: ["未开始", "演练中", "通过", "需复盘", "阻塞"],
  results: ["通过", "部分通过", "未通过", "待确认"],
  rounds: ["1", "2", "3"],
  devices: ["录音卡", "AI耳机", "手机录音", "会议录音", "其他"],
  audioStatuses: ["待上传", "已上传", "已转写", "已分析", "需重录", "不可用"],
  issueTypes: ["知识缺失", "规则缺失", "话术不准", "接口/数据", "流程不闭环", "权限/合规", "体验问题", "埋点缺失"],
  priorities: ["P0-必须当天解决", "P1-本周解决", "P2-可排期", "P3-观察"],
  impact: ["是", "否", "部分影响"],
  issueStatuses: ["待确认", "待开发", "开发中", "待验收", "已关闭", "暂缓"],
  roles: ["网络", "市场", "装维", "营业厅", "开发", "AI"],
  sceneTags: ["测试数据"],
};

const dictionaryLabels = {
  sceneTypes: "场景类型",
  statuses: "通用状态",
  results: "演练结果",
  rounds: "轮次",
  devices: "采集设备",
  audioStatuses: "录音分析状态",
  issueTypes: "问题类型",
  priorities: "优先级",
  impact: "是否影响演练",
  issueStatuses: "问题状态",
  roles: "角色",
  sceneTags: "场景标签",
};

const sampleSubmitter = {
  tags: "测试数据",
  submitterName: "AI",
  submitterPhone: "19900000000",
  submitterUnit: "AICP",
  submitterRole: "AI",
  collectorName: "AI",
  collectorPhone: "19900000000",
  collectorUnit: "AICP",
  collectorRole: "AI",
  updatedByName: "AI",
  updatedByPhone: "19900000000",
  updatedByUnit: "AICP",
  updatedByRole: "AI",
};

const initialData = {
  scenes: [
    {
      id: "BZ-001",
      type: "基本保障",
      target: "宽带断网报障识别",
      description: "家庭用户反馈宽带无法上网，已重启仍无效，并表达马上要开会的紧急诉求。",
      audioName: "20260506_BZ001_01.mp3",
      keywords: "断网;重启无效;开会;光猫;区域告警",
      dataNeeded: "用户原话、灯态、地址/账号、排障动作、是否派单、承诺时限",
      devSupport: "训练AI识别断网类型、排障路径、派单边界和安抚话术",
      owner: "邵新",
      status: "未开始",
      note: "",
    },
    {
      id: "BZ-002",
      type: "基本保障",
      target: "装机进度查询",
      description: "新装用户咨询什么时候上门安装，关注预约时间和是否能改约。",
      audioName: "20260506_BZ002_01.mp3",
      keywords: "新装;预约;改约;端口;排班",
      dataNeeded: "订单状态、预约时间、卡点原因、责任人、用户确认结果",
      devSupport: "支撑AI查询装机状态、解释卡点、输出改约/升级路径",
      owner: "邵新",
      status: "未开始",
      note: "",
    },
    {
      id: "BZ-003",
      type: "基本保障",
      target: "电视卡顿/IPTV故障",
      description: "中年家庭反馈电视卡顿、黑屏或动画片转圈，需要排查IPTV和带宽问题。",
      audioName: "20260506_BZ003_01.mp3",
      keywords: "电视卡顿;黑屏;IPTV;动画片;带宽",
      dataNeeded: "机顶盒状态、测速结果、电视使用场景、处理动作、是否推荐升级",
      devSupport: "支撑AI识别电视/IPTV故障路径及电视周边产品协同推荐",
      owner: "邵新",
      status: "未开始",
      note: "",
    },
    {
      id: "FW-001",
      type: "服务",
      target: "账单费用解释",
      description: "老用户质疑本月费用变高，怀疑乱扣费，需要解释账单差异。",
      audioName: "20260506_FW001_01.mp3",
      keywords: "费用变高;乱扣费;账单;优惠到期;增值业务",
      dataNeeded: "账期、费用差异项、解释口径、用户是否接受、后续动作",
      devSupport: "支撑AI做费用拆解、优惠到期解释和申诉/退订建议",
      owner: "小罗",
      status: "未开始",
      note: "",
    },
    {
      id: "FW-002",
      type: "服务",
      target: "套餐变更咨询",
      description: "用户希望降档或更换套餐，需要查询合约、用量并给出可办理方案。",
      audioName: "20260506_FW002_01.mp3",
      keywords: "套餐太贵;降档;合约;用量;生效时间",
      dataNeeded: "当前套餐、合约限制、用量、推荐方案、生效时间、用户确认结果",
      devSupport: "支撑AI推荐套餐方案并说明合约/生效/风险边界",
      owner: "小罗",
      status: "未开始",
      note: "",
    },
    {
      id: "FW-003",
      type: "服务",
      target: "投诉安抚与升级",
      description: "用户对处理不满要求投诉，情绪较激动，需要安抚并明确升级反馈时间。",
      audioName: "20260506_FW003_01.mp3",
      keywords: "投诉;没人处理;等待;升级;反馈时限",
      dataNeeded: "用户情绪、历史工单、安抚话术、升级对象、反馈节点",
      devSupport: "支撑AI识别情绪风险、进入纯服务模式、生成升级闭环",
      owner: "姚炳阳",
      status: "未开始",
      note: "情绪触发重点样本",
    },
    {
      id: "SX-001",
      type: "随销",
      target: "故障后提速/组网机会识别",
      description: "故障处理后，用户提到孩子上网课、打游戏卡顿，存在提速或家庭组网机会。",
      audioName: "20260506_SX001_01.mp3",
      keywords: "卡顿;上网课;打游戏;多设备;组网",
      dataNeeded: "当前套餐、设备数、户型、痛点、推荐产品、用户意向",
      devSupport: "支撑AI先服务后推荐、识别商机、控制推荐时机和话术",
      owner: "杨浩",
      status: "未开始",
      note: "",
    },
    {
      id: "SX-003",
      type: "随销",
      target: "FTTR/家庭组网推荐",
      description: "上门服务中发现卧室信号弱，用户愿意改善但担心价格。",
      audioName: "20260506_SX003_01.mp3",
      keywords: "卧室信号弱;路由器;FTTR;价格;合约",
      dataNeeded: "测速结果、房间布局、报价、异议、是否留资/成交",
      devSupport: "支撑AI用测速证据推荐FTTR，处理价格和合约合规问题",
      owner: "杨浩",
      status: "未开始",
      note: "报价和合规重点",
    },
    {
      id: "YC-001",
      type: "异常升级",
      target: "多意图拆分与转人工",
      description: "用户一次说网络慢、账单不对、优惠没给，AI需要拆分并判断处理顺序。",
      audioName: "20260506_YC001_01.mp3",
      keywords: "网慢;账单不对;优惠;多个问题;转人工",
      dataNeeded: "用户多诉求原话、AI拆分结果、追问、转人工原因",
      devSupport: "支撑AI多意图识别、上下文保留和人工转接摘要",
      owner: "产品/开发",
      status: "未开始",
      note: "",
    },
  ],
  schedule: [
    ["上午", "09:00-09:30", "-", "开场+人员到位+设备调试+流程讲解", "铁通4楼", "邵新", "全体到场", "未开始"],
    ["上午", "09:30-10:30", "BZ-001", "宽带断网报障识别", "铁通4楼", "邵新", "M-A / 用户1 / AI-EAR / 记录员", "未开始"],
    ["上午", "10:40-11:30", "BZ-002", "装机进度查询", "铁通4楼", "邵新", "M-B / 用户2 / AI-EAR / 记录员", "未开始"],
    ["上午", "11:30-12:20", "BZ-003", "电视卡顿/IPTV故障", "铁通4楼", "邵新", "M-A / 用户2 / AI-EAR / 记录员", "未开始"],
    ["下午", "13:30-14:10", "FW-001", "账单费用解释", "铁通4楼", "小罗", "服务支撑 / 用户 / AI-EAR / 记录员", "未开始"],
    ["下午", "14:10-14:50", "FW-003", "投诉安抚与升级", "铁通4楼", "姚炳阳", "服务支撑 / 投诉客户 / AI-EAR / 记录员", "未开始"],
    ["下午", "15:00-15:50", "SX-001", "故障后提速/组网机会识别", "333/铁通待定", "杨浩", "一线 / 用户 / AI-EAR / 记录员", "未开始"],
    ["下午", "16:00-16:50", "SX-003", "FTTR/家庭组网推荐", "333/铁通待定", "杨浩", "培推师 / 用户 / AI-EAR / 记录员", "未开始"],
    ["下午", "17:00-17:30", "YC-001", "多意图拆分与转人工", "铁通4楼", "产品/开发", "产品 / 开发 / AI-OBS / 记录员", "未开始"],
    ["收口", "17:30-18:00", "-", "当日总结+数据交付确认", "铁通4楼", "邵新+好活", "全体核心人员", "未开始"],
  ],
  records: [
    {
      id: "LOG-SAMPLE-001",
      time: "09:42",
      sceneId: "BZ-001",
      round: "1",
      target: "宽带断网报障识别",
      description: "用户反馈全屋无法上网，光猫 LOS 红灯闪，十分钟后要开线上会议。",
      device: "录音卡",
      audioName: "20260506_BZ001_sample_01.mp3",
      minutes: "8",
      userText: "用户原话：家里网突然断了，重启路由器也不行，孩子马上要上网课，我现在很着急。",
      actual: "一线师傅先确认灯态和地址，判断疑似光路/区域故障；安抚用户并承诺优先派单，同时提醒保留光猫状态。",
      expected: "训练AI识别断网类型、排障路径、派单边界和安抚话术",
      result: "部分通过",
      keywords: "断网;LOS红灯;重启无效;上网课;优先派单",
      problem: "AI容易直接推荐重启，缺少对 LOS 红灯和紧急场景的优先级判断。",
      analysis: "需要大模型从用户情绪、灯态、时间压力三个维度判断是否进入紧急保障流程。",
      devSupport: "增加灯态字段、紧急程度字段、是否区域故障字段，并生成派单摘要。",
      recorder: "",
      note: "测试样例：用于说明现场记录怎么写细。",
      ...sampleSubmitter,
    },
    {
      id: "LOG-SAMPLE-002",
      time: "14:26",
      sceneId: "FW-003",
      round: "1",
      target: "投诉安抚与升级",
      description: "用户连续两天催单未解决，表达要投诉到上级。",
      device: "录音卡",
      audioName: "20260506_FW003_sample_01.mp3",
      minutes: "6",
      userText: "用户原话：昨天说今天给我回电，到现在没人联系，我不要再听解释了，我要投诉。",
      actual: "先复述用户诉求并道歉，确认历史工单和回访承诺，明确升级到网络部值班经理并给出 2 小时反馈节点。",
      expected: "支撑AI识别情绪风险、进入纯服务模式、生成升级闭环",
      result: "通过",
      keywords: "投诉;没人回电;历史工单;升级;2小时反馈",
      problem: "需要记录承诺时限和升级对象，否则后续闭环不可追踪。",
      analysis: "关注 AI 是否停止营销推荐、是否生成可交接的投诉摘要。",
      devSupport: "沉淀投诉闭环字段：历史承诺、升级对象、反馈时限、下一责任人。",
      recorder: "",
      note: "测试样例：投诉场景要把情绪和闭环写清楚。",
      ...sampleSubmitter,
    },
    {
      id: "LOG-SAMPLE-003",
      time: "16:18",
      sceneId: "SX-003",
      round: "1",
      target: "FTTR/家庭组网推荐",
      description: "上门排障发现卧室测速低，用户担心 FTTR 价格和合约限制。",
      device: "录音卡",
      audioName: "20260506_SX003_sample_01.mp3",
      minutes: "9",
      userText: "用户原话：客厅还行，卧室刷视频老卡。可以改善我愿意听，但别给我办太贵的。",
      actual: "师傅先完成测速并展示卧室弱覆盖证据，再说明 FTTR/组网方案、费用口径和可选办理路径，最后确认用户愿意留资。",
      expected: "支撑AI用测速证据推荐FTTR，处理价格和合约合规问题",
      result: "部分通过",
      keywords: "卧室弱覆盖;测速证据;FTTR;价格异议;留资",
      problem: "AI推荐时机要在故障解释完成后，不能一上来销售。",
      analysis: "需要分析服务完成节点、证据是否充分、价格异议是否被合规处理。",
      devSupport: "增加随销触发条件、证据截图/测速字段、用户意向等级和下一步动作。",
      recorder: "",
      note: "测试样例：随销场景要体现先服务后推荐。",
      ...sampleSubmitter,
    },
  ],
  audio: [
    {
      id: "AUD-SAMPLE-001",
      audioName: "20260506_BZ001_sample_01.mp3",
      sceneId: "BZ-001",
      round: "1",
      target: "宽带断网报障识别",
      device: "录音卡",
      period: "09:30-10:30",
      minutes: "8",
      keywords: "断网;LOS红灯;紧急保障;派单",
      triggerText: "家里网突然断了，重启也没用，孩子马上要上网课。",
      intent: "宽带故障/紧急保障",
      speaker: "用户/一线/AI",
      summary: "用户高紧急度断网报障，关键证据为 LOS 红灯和重启无效，应进入排障+派单路径。",
      devSupport: "为 AI 训练提供灯态、紧急度、派单边界和安抚话术样本。",
      action: "上传真实录音后由大模型转写，校验灯态识别和派单摘要是否准确。",
      status: "待上传",
      hasAudioFile: false,
      audioFileSize: "",
      audioUploadedAt: "",
      note: "测试样例：录音未上传时也先记录关键词。",
      ...sampleSubmitter,
    },
    {
      id: "AUD-SAMPLE-002",
      audioName: "20260506_FW003_sample_01.mp3",
      sceneId: "FW-003",
      round: "1",
      target: "投诉安抚与升级",
      device: "录音卡",
      period: "14:10-14:50",
      minutes: "6",
      keywords: "投诉;升级;回访承诺;情绪风险",
      triggerText: "没人联系，我不要再听解释了，我要投诉。",
      intent: "投诉安抚/升级闭环",
      speaker: "用户/服务支撑/AI",
      summary: "用户对历史承诺未兑现不满，AI应进入服务安抚和升级闭环，不应触发营销推荐。",
      devSupport: "训练投诉摘要、升级对象、承诺反馈时间和责任人字段。",
      action: "检查 AI 是否生成可复制给后台处理人的一段式交接摘要。",
      status: "待上传",
      hasAudioFile: false,
      audioFileSize: "",
      audioUploadedAt: "",
      note: "测试样例：投诉录音重点看情绪和闭环。",
      ...sampleSubmitter,
    },
    {
      id: "AUD-SAMPLE-003",
      audioName: "20260506_SX003_sample_01.mp3",
      sceneId: "SX-003",
      round: "1",
      target: "FTTR/家庭组网推荐",
      device: "录音卡",
      period: "16:00-16:50",
      minutes: "9",
      keywords: "弱覆盖;测速;FTTR;价格异议;留资",
      triggerText: "卧室刷视频老卡，可以改善我愿意听，但别太贵。",
      intent: "服务后随销/家庭组网",
      speaker: "用户/装维/AI",
      summary: "服务过程中出现明确弱覆盖痛点，推荐需要基于测速证据并处理价格异议。",
      devSupport: "训练随销触发时机、证据充分性、合规价格说明和意向等级。",
      action: "后续补充真实 mp3 后，验证 AI 是否能区分服务话术和销售话术。",
      status: "待上传",
      hasAudioFile: false,
      audioFileSize: "",
      audioUploadedAt: "",
      note: "测试样例：随销录音要记录触发条件。",
      ...sampleSubmitter,
    },
  ],
  issues: [
    {
      id: "ISS-SAMPLE-001",
      sceneId: "BZ-001",
      target: "宽带断网报障识别",
      type: "规则缺失",
      problem: "AI 对 LOS 红灯、PON 灯不亮等灯态信息没有稳定追问，容易把光路问题当普通 Wi-Fi 问题处理。",
      need: "补充灯态追问规则：是否亮灯、是否红灯、是否闪烁、是否重启无效，并映射到故障类型。",
      evidence: "测试记录 LOG-SAMPLE-001；关键词：LOS红灯、重启无效、上网课。",
      priority: "P1-本周解决",
      impact: "是",
      owner: "网络/开发",
      status: "待开发",
      audioName: "20260506_BZ001_sample_01.mp3",
      acceptance: "AI 能在用户提到断网后主动追问灯态，并在 LOS 红灯时输出派单建议和安抚话术。",
      note: "测试样例：问题要能转成开发任务。",
      ...sampleSubmitter,
    },
    {
      id: "ISS-SAMPLE-002",
      sceneId: "FW-003",
      target: "投诉安抚与升级",
      type: "流程不闭环",
      problem: "投诉场景只生成安抚话术，没有结构化记录升级对象、承诺反馈时限和下一责任人。",
      need: "增加投诉闭环字段，并在大模型分析结果中强制输出。",
      evidence: "测试记录 LOG-SAMPLE-002；用户明确要求投诉且提到历史承诺未兑现。",
      priority: "P0-必须当天解决",
      impact: "是",
      owner: "服务/开发",
      status: "待开发",
      audioName: "20260506_FW003_sample_01.mp3",
      acceptance: "AI 输出包含：历史承诺、当前诉求、升级对象、反馈时限、责任人、用户情绪等级。",
      note: "测试样例：P0 问题要写清验收标准。",
      ...sampleSubmitter,
    },
    {
      id: "ISS-SAMPLE-003",
      sceneId: "SX-003",
      target: "FTTR/家庭组网推荐",
      type: "埋点缺失",
      problem: "随销场景没有记录推荐触发点和用户异议，后续无法训练 AI 判断什么时候可以推荐。",
      need: "增加触发点、证据类型、用户异议、意向等级、下一步动作五个字段。",
      evidence: "测试记录 LOG-SAMPLE-003；用户提到卧室卡顿且担心价格。",
      priority: "P1-本周解决",
      impact: "部分影响",
      owner: "市场/开发",
      status: "待确认",
      audioName: "20260506_SX003_sample_01.mp3",
      acceptance: "AI 分析结果能区分服务完成前/后推荐，并记录价格异议与留资动作。",
      note: "测试样例：随销要有证据和合规边界。",
      ...sampleSubmitter,
    },
  ],
  currentUser: structuredClone(EMPTY_USER),
  users: structuredClone(defaultUsers),
  dictionaries: structuredClone(initialDictionaries),
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
  return merged;
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
  return Boolean(state.currentUser?.name && state.currentUser?.phone && state.currentUser?.unit && state.currentUser?.role);
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
  fillSummary();
  renderLoginState();
  hydrateAudioPlayers();
}

function renderKpis() {
  $("#kpiScenes").textContent = state.scenes.length;
  $("#kpiRecords").textContent = state.records.length;
  $("#kpiAudio").textContent = state.audio.filter((item) => item.audioName).length;
  $("#kpiMinutes").textContent = state.audio.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  $("#kpiOpenIssues").textContent = state.issues.filter((issue) => !["已关闭", "暂缓"].includes(issue.status)).length;
}

function renderSchedule() {
  $("#scheduleBody").innerHTML = state.schedule
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => matchesQuery(row, filters.schedule))
    .map(
      ({ row, index }) => `
        <tr>
          ${row
            .map((cell, cellIndex) => {
              if (cellIndex === 7) {
                return `<td><select data-schedule-index="${index}">${dict("statuses")
                  .map((option) => `<option ${option === cell ? "selected" : ""}>${option}</option>`)
                  .join("")}</select></td>`;
              }
              return `<td>${escapeHtml(cell)}</td>`;
            })
            .join("")}
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
  ["result", "演练结果", "selectResult"],
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
  ["status", "状态", "selectAudioStatus"],
];

const issueFields = [
  ["sceneId", "来源场景ID", "selectScene"],
  ["type", "问题类型", "selectIssueType"],
  ["tags", "标签", "selectSceneTag"],
  ["priority", "优先级", "selectPriority"],
  ["impact", "是否影响5月6日演练", "selectImpact"],
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
  return {
    id: data.id || `AUD-${String(state.audio.length + 1).padStart(3, "0")}`,
    audioName: normalizeMp3(data.audioName || uploadedFile?.name || `${scene.id}_${data.round || 1}.mp3`),
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
  const existing = state.users.find((item) => item.phone === state.currentUser.phone || item.name === state.currentUser.name);
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

function fillSummary() {
  $("#summaryCompleted").value = state.summary.completed || "";
  $("#summaryTopAudio").value = state.summary.topAudio || "";
  $("#summaryAiGap").value = state.summary.aiGap || "";
  $("#summaryBlocker").value = state.summary.blocker || "";
  $("#summaryRerun").value = state.summary.rerun || "";
  $("#summaryNext").value = state.summary.next || "";
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
    ["类型", "ID", "场景ID", "目标场景", "录音文件", "标签", "关键词", "开发支撑点", "状态/结果", "提交人", "手机号", "单位", "角色", "本地音频"],
    ...state.scenes.map((item) => [
      "场景清单",
      item.id,
      item.id,
      item.target,
      item.audioName,
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.status,
      ...submitterValues(item),
      "",
    ]),
    ...state.records.map((item) => [
      "现场记录",
      item.id,
      item.sceneId,
      item.target,
      item.audioName,
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.result,
      ...submitterValues(item),
      "",
    ]),
    ...state.audio.map((item) => [
      "录音关键词",
      item.id,
      item.sceneId,
      item.target,
      item.audioName,
      item.tags || "测试数据",
      item.keywords,
      item.devSupport,
      item.status,
      ...submitterValues(item),
      item.hasAudioFile ? "已上传" : "未上传",
    ]),
    ...state.issues.map((item) => [
      "问题需求",
      item.id,
      item.sceneId,
      item.target,
      item.audioName,
      item.tags || "测试数据",
      item.problem,
      item.evidence,
      item.status,
      ...submitterValues(item),
      "",
    ]),
    ...state.users.map((item) => [
      "人员列表",
      userKey(item),
      "",
      item.name,
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
    ]),
    ...Object.entries(state.dictionaries).map(([key, values]) => [
      "字典表",
      key,
      "",
      dictionaryLabels[key] || key,
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

function initEvents() {
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
    upsertById(state.audio, editingId, audio);
    const uploadedMessage = data.audioFile?.size ? "录音文件已上传服务器并校验通过。" : "";
    return saveState(`${editingId ? "录音关键词修改已提交并同步。" : "录音关键词已提交并同步。"}${uploadedMessage}`);
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

  $("#saveSummaryBtn").addEventListener("click", async () => {
    state.summary = {
      completed: $("#summaryCompleted").value,
      topAudio: $("#summaryTopAudio").value,
      aiGap: $("#summaryAiGap").value,
      blocker: $("#summaryBlocker").value,
      rerun: $("#summaryRerun").value,
      next: $("#summaryNext").value,
    };
    await saveState("当日复盘摘要已提交并同步。");
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
      showSyncStatus("ok");
      showToast("共享数据已重置。", "success");
    } catch (err) {
      showToast(`重置失败：${err.message}`, "error");
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
    if (index !== undefined) {
      state.schedule[Number(index)][7] = event.target.value;
      saveState("日程状态已更新并同步。");
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
    showSyncStatus("ok");
  } catch (err) {
    console.error(err);
    showSyncStatus("offline", "无法连接服务器，先以本地模式工作。");
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollForUpdates, POLL_INTERVAL_MS);
}

bootstrap();
