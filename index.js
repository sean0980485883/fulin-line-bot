const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const app = express();
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
// ─── 設定持久化（Upstash Redis） ──────────────────────────────
// 每個群組的設定（語言模式、翻譯開關、忽略狀態、記事、定時提醒…）都會存到 Upstash
// Redis（免費外部服務），不是存在 Render 的本機硬碟。
// 原因：Render 的本機硬碟只要「重新部署」就會整個清空，免費版/付費版都一樣（除非
// 額外加購 Persistent Disk）。改存到 Upstash 之後，不管重新部署、休眠喚醒、當機
// 重啟都不會遺失設定。
// 設定方式：到 upstash.com 免費建立一個 Redis 資料庫，把它給的 REST URL／TOKEN
// 填進 Render 環境變數 UPSTASH_REDIS_REST_URL／UPSTASH_REDIS_REST_TOKEN。
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = "fulin-line-bot:state";
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map(id => id.trim()).filter(Boolean)
  : [];
let allowedUsers = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(",").map(id => id.trim()).filter(Boolean))
  : new Set();
// ─── 定時提醒系統 ──────────────────────────────────────────────
// 結構：Map<sourceId, [{id, hour, minute, message, timerId}]>
const groupReminders = new Map();
let reminderIdCounter = 1;
function getTWNow() {
  // 台灣時間 UTC+8
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw;
}
function getNextTriggerMs(hour, minute) {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const next = new Date(tw);
  next.setUTCHours(hour - 8 < 0 ? hour - 8 + 24 : hour - 8, minute, 0, 0);
  // 換算回 UTC
  const nextUTC = new Date(next.getTime());
  if (nextUTC <= now) nextUTC.setUTCDate(nextUTC.getUTCDate() + 1);
  return nextUTC - now;
}
function scheduleReminder(sourceId, reminder) {
  const { hour, minute, message, id } = reminder;
  function trigger() {
    const tw = getTWNow();
    console.log(`[Reminder #${id}] 發送提醒到 ${sourceId}：${message}`);
    // 在群組發送真的 @全體 通知 + 提醒內容
    pushToGroup(sourceId, `⏰ ${message}`);
    // 設定下一次（24小時後）
    reminder.timerId = setTimeout(trigger, getNextTriggerMs(hour, minute));
  }
  const delay = getNextTriggerMs(hour, minute);
  const nextTW = new Date(Date.now() + delay + 8 * 60 * 60 * 1000);
  console.log(`[Reminder #${id}] 下次發送：台灣時間 ${String(nextTW.getUTCHours()).padStart(2,'0')}:${String(nextTW.getUTCMinutes()).padStart(2,'0')}（${Math.round(delay/1000/60)} 分鐘後）`);
  reminder.timerId = setTimeout(trigger, delay);
}
// ─── LINE Push 到群組（用 Push API，並用 textV2 真的 @全體 通知） ──────
async function pushToGroup(groupId, text) {
  try {
    const r = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        to: groupId,
        messages: [{
          type: "textV2",
          text: "{everyone}\n" + text,
          substitution: {
            everyone: { type: "mention", mentionee: { type: "all" } }
          }
        }]
      },
      { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" }, timeout: 10000 }
    );
    console.log("[PushGroup] to:", groupId, "status:", r.status);
  } catch (err) {
    console.error("[PushGroup ERROR]", groupId, err.response ? JSON.stringify(err.response.data) : err.message);
  }
}
const translateEnabled = new Map();
// ─── 語言模式系統 ─────────────────────────────────────────────
// 每個群組獨立設定語言模式
const groupLangMode = new Map();
const LANG_MODES = {
  ZH_TH_EN: {
    name: "中泰英",
    desc: "中文 ↔ 泰文 ↔ 英文",
    system: `你是翻譯助理，翻譯語言範圍：中文、泰文、英文。
規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（國旗符號 + 空格 + 翻譯，每行一個，不加任何其他文字）：
   - 輸入是中文 → 🇹🇭 [泰文]\n🇺🇸 [英文]
   - 輸入是泰文 → 🇹🇼 [中文]\n🇺🇸 [英文]
   - 輸入是英文 → 🇹🇼 [中文]\n🇹🇭 [泰文]
4. 只輸出翻譯結果，不加冒號、箭頭、語言名稱或任何說明`
  },
  ID_ZH_EN: {
    name: "印尼中英",
    desc: "印尼文 ↔ 中文 ↔ 英文",
    system: `你是翻譯助理，翻譯語言範圍：印尼文、中文、英文。
規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（國旗符號 + 空格 + 翻譯，每行一個，不加任何其他文字）：
   - 輸入是印尼文 → 🇹🇼 [中文]\n🇺🇸 [英文]
   - 輸入是中文 → 🇮🇩 [印尼文]\n🇺🇸 [英文]
   - 輸入是英文 → 🇮🇩 [印尼文]\n🇹🇼 [中文]
4. 只輸出翻譯結果，不加冒號、箭頭、語言名稱或任何說明`
  },
  ZH_EN: {
    name: "中英",
    desc: "中文 ↔ 英文",
    system: `你是翻譯助理，翻譯語言範圍：中文、英文。
規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（國旗符號 + 空格 + 翻譯，每行一個，不加任何其他文字）：
   - 輸入是中文 → 🇺🇸 [英文]
   - 輸入是英文 → 🇹🇼 [中文]
4. 只輸出翻譯結果，不加冒號、箭頭、語言名稱或任何說明`
  },
  ZH_MY_EN: {
    name: "中緬英",
    desc: "中文 ↔ 緬甸文 ↔ 英文",
    system: `你是翻譯助理，翻譯語言範圍：中文、緬甸文、英文。
規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（國旗符號 + 空格 + 翻譯，每行一個，不加任何其他文字）：
   - 輸入是中文 → 🇲🇲 [緬甸文]\n🇺🇸 [英文]
   - 輸入是緬甸文 → 🇹🇼 [中文]\n🇺🇸 [英文]
   - 輸入是英文 → 🇹🇼 [中文]\n🇲🇲 [緬甸文]
4. 只輸出翻譯結果，不加冒號、箭頭、語言名稱或任何說明`
  },
  ZH_MY_EN_TH: {
    name: "中緬英泰",
    desc: "中文 ↔ 緬甸文 ↔ 英文 ↔ 泰文",
    system: `你是翻譯助理，翻譯語言範圍：中文、緬甸文、英文、泰文。
規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（國旗符號 + 空格 + 翻譯，每行一個，不加任何其他文字）：
   - 輸入是中文 → 🇲🇲 [緬甸文]\n🇺🇸 [英文]\n🇹🇭 [泰文]
   - 輸入是緬甸文 → 🇹🇼 [中文]\n🇺🇸 [英文]\n🇹🇭 [泰文]
   - 輸入是英文 → 🇹🇼 [中文]\n🇲🇲 [緬甸文]\n🇹🇭 [泰文]
   - 輸入是泰文 → 🇹🇼 [中文]\n🇲🇲 [緬甸文]\n🇺🇸 [英文]
4. 只輸出翻譯結果，不加冒號、箭頭、語言名稱或任何說明`
  }
};
function getGroupMode(sourceId) {
  return groupLangMode.get(sourceId) || "ZH_TH_EN";
}
function isTranslateOn(sourceId) {
  return translateEnabled.get(sourceId) !== false;
}
// ─── 群組管理 ──────────────────────────────────────────────────
async function fetchGroupName(groupId) {
  try {
    const r = await axios.get(
      `https://api.line.me/v2/bot/group/${groupId}/summary`,
      { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN }, timeout: 5000 }
    );
    return r.data.groupName || groupId.substring(0, 8) + "...";
  } catch (err) {
    return groupId.substring(0, 8) + "...";
  }
}
const groups = new Map();
async function getOrCreateGroup(sourceId, eventSource = null) {
  if (!groups.has(sourceId)) {
    groups.set(sourceId, { name: sourceId.substring(0, 8) + "...", lastActiveAt: new Date() });
    if (eventSource && eventSource.type === "group") {
      fetchGroupName(sourceId).then(name => {
        if (groups.has(sourceId)) {
          groups.get(sourceId).name = name;
          console.log("[GroupName]", name);
          saveState();
        }
      });
    }
  }
  return groups.get(sourceId);
}
function touchGroup(sourceId) {
  if (groups.has(sourceId)) groups.get(sourceId).lastActiveAt = new Date();
}
// ─── 讀取 / 儲存持久化設定 ────────────────────────────────────
function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    allowedUsers: [...allowedUsers],
    translateEnabled: Object.fromEntries(translateEnabled),
    groupLangMode: Object.fromEntries(groupLangMode),
    glossary: Object.fromEntries(GLOSSARY),
    reminderIdCounter,
    groups: Object.fromEntries(
      [...groups].map(([sourceId, g]) => [sourceId, {
        name: g.name,
        lastActiveAt: g.lastActiveAt instanceof Date ? g.lastActiveAt.toISOString() : g.lastActiveAt,
      }])
    ),
    groupReminders: Object.fromEntries(
      [...groupReminders].map(([sourceId, list]) => [
        sourceId,
        list.map(r => ({ id: r.id, hour: r.hour, minute: r.minute, message: r.message })),
      ])
    ),
  };
}
const UPSTASH_CONFIGURED = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
async function saveState() {
  if (!UPSTASH_CONFIGURED) {
    console.error("[State] 尚未設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN，這次設定不會被保存");
    return;
  }
  try {
    await axios.post(
      `${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(STATE_KEY)}`,
      JSON.stringify(serializeState()),
      { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "text/plain" }, timeout: 10000 }
    );
  } catch (err) {
    console.error("[State] 儲存設定失敗：", err.response ? JSON.stringify(err.response.data) : err.message);
  }
}
async function loadState() {
  if (!UPSTASH_CONFIGURED) {
    console.log("[State] 尚未設定 Upstash，使用預設值啟動（這次執行期間的設定不會被保存）");
    return;
  }
  try {
    const r = await axios.get(
      `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(STATE_KEY)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }, timeout: 10000 }
    );
    const raw = r.data && r.data.result;
    if (!raw) {
      console.log("[State] 尚無已儲存設定，使用預設值啟動");
      return;
    }
    const data = JSON.parse(raw);
    (data.allowedUsers || []).forEach(id => allowedUsers.add(id));
    Object.entries(data.translateEnabled || {}).forEach(([id, v]) => translateEnabled.set(id, v));
    Object.entries(data.groupLangMode || {}).forEach(([id, mode]) => groupLangMode.set(id, mode));
    Object.entries(data.glossary || {}).forEach(([term, note]) => GLOSSARY.set(term, note));
    if (typeof data.reminderIdCounter === "number") reminderIdCounter = data.reminderIdCounter;
    Object.entries(data.groups || {}).forEach(([sourceId, g]) => {
      groups.set(sourceId, {
        name: g.name,
        lastActiveAt: g.lastActiveAt ? new Date(g.lastActiveAt) : new Date(),
      });
    });
    let restoredReminders = 0;
    Object.entries(data.groupReminders || {}).forEach(([sourceId, list]) => {
      const restored = list.map(r => ({ ...r, timerId: null }));
      groupReminders.set(sourceId, restored);
      restored.forEach(r => { scheduleReminder(sourceId, r); restoredReminders++; });
    });
    console.log(`[State] 已從 Upstash 讀回設定：${groups.size} 個群組、${restoredReminders} 筆定時提醒已重新排定`);
  } catch (err) {
    console.error("[State] 讀取設定失敗，將使用預設值啟動：", err.response ? JSON.stringify(err.response.data) : err.message);
  }
}
async function pushMessage(toUserId, messages) {
  try {
    const r = await axios.post("https://api.line.me/v2/bot/message/push",
      { to: toUserId, messages },
      { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" }, timeout: 10000 }
    );
    console.log("[Push] to:", toUserId, "status:", r.status);
  } catch (err) {
    console.error("[Push ERROR]", toUserId, err.response ? JSON.stringify(err.response.data) : err.message);
  }
}
// ─── 📖 詞彙庫：指定詞彙固定怎麼翻（或保留原文不翻），讓同一個詞每次翻譯結果都一致；
// 預設先放產品/公司名稱，管理員可用 @加詞彙 / @詞彙庫 / @刪除詞彙 自行增減 ───
const GLOSSARY = new Map(
  [
    "黑框木紋", "白框木紋", "白框白板", "白框灰黑", "黑框白板", "黑框灰黑",
    "大衛浴", "小衛浴", "水泥廁所", "室外衛浴", "貼磁衛浴", "日式衛浴",
    "二樓", "三樓", "展翼屋", "20呎展翼屋", "折疊屋", "宿舍",
    "廚具", "SPC地板", "三合一門", "標準窗", "沙門", "DM",
    "富林", "富林組合屋", "澄舍傢俱", "aafulin",
  ].map(term => [term, "保留原文，不要翻譯這個詞"])
);
// 以下從「富林組合屋工作台」管理後台的「施作項目（中／泰）」清單匯入，是實際用過、校對過的泰文翻法，
// 同名詞彙會覆蓋掉上面「保留原文」的預設值 ───
[
  ["4*6", "4*6"],
  ["4*8", "4*8"],
  ["3*6", "3*6"],
  ["3*8", "3*8"],
  ["1顆", "1หลัง"],
  ["2顆", "2 หลัง"],
  ["3顆", "3 หลัง"],
  ["4顆", "4หลัง"],
  ["5顆", "5หลัง"],
  ["高板330cm", "ผนังสูง330cm"],
  ["重板", "แผ่นหนัก"],
  ["暗管", "ซ่อนสายไฟ"],
  ["三合一門-黑灰", "ประตู 3 in 1 - สีดำ"],
  ["地螺絲", "น็อตยึดพื้น"],
  ["配電", "ระบบไฟ"],
  ["衛浴設備", "สุขภัณฑ์ห้องน้ำ"],
  ["日式衛浴", "ห้องน้ำญี่ปุ่น"],
  ["磁磚鋪設", "ห้องน้ำปูน"],
  ["pvc", "PVC"],
  ["組合屋配管", "ต่อท่อน้ำ"],
  ["化糞池配管", "ต่อท่อน้ำบ่อเกรอะ"],
  ["板模點焊網", "ตีแบบ+ไวเมต"],
  ["水泥", "ปูน"],
  ["組合屋組裝", "ติดตั้งบ้าน"],
  ["屋頂", "หลังคา"],
  ["修繕", "ซ่อมแซม"],
  ["漏水", "น้ำรั่ว"],
  ["露臺", "ระเบียง"],
  ["10米", "10 เมตร"],
  ["20米", "20 เมตร"],
  ["30米", "30 เมตร"],
  ["40米", "40 เมตร"],
  ["50米", "50 เมตร"],
  ["60米", "60 เมตร"],
  ["內部收尾", "เก็บงานภายใน"],
  ["底下封邊油漆", "ปิดขอบบ้าน+ทาสี"],
  ["大衛浴", "ห้องน้ำใหญ่"],
  ["小衛浴", "ห้องน้ำเล็ก"],
  ["戶外衛浴", "WCปูนภายนอก"],
  ["地面固定", "พุกยึดพื้น"],
  ["換沙門", "เปลี่ยนมุ้งหน้าต่าง"],
  ["黑框木紋", "โครงดำผนังลายไม้"],
  ["黑框黑板", "โครงดำ ผนังดำ"],
  ["黑框白板", "โครงดำ ผนังขาว"],
  ["白框木紋", "โครงขาวผนังลายไม้"],
  ["白框白板", "โครงขาว ผนังขาว"],
  ["白框黑板", "โครงดำ ผนังดำ"],
  ["外接電", "เดินสายเมน"],
  ["噴漆/補漆", "พ้นสีสเปรย์"],
  ["天花", "ฝ้า"],
  ["紗窗", "มุ้งหน้าต่าง"],
  ["窗簾", "ม่านหน้าต่าง"],
  ["熱水器", "เครื่องทำน้ำอุ่น"],
  ["住宿", "ที่พัก"],
  ["開放式展翼屋", "บ้านพับ"],
  ["水塔", "แท้งค์น้ำ"],
  ["標準窗紗窗", "มุ้งหน้าต่างธรรมดา"],
  ["馬達", "มอเตอร์"],
  ["樓梯", "บันได"],
  ["丟垃圾", "ทิ้งขยะ"],
  ["摺疊屋", "บ้านพับ"],
  ["水平", " ระดับ"],
  ["基本窗-黑灰", "หน้าต่างธรรมดา-สีดำ"],
  ["門窗", "ประตูและหน้าต่าง"],
  ["188玻璃門", "กระจกประตู 188"],
].forEach(([zh, th]) => GLOSSARY.set(zh, `固定翻成泰文「${th}」`));
function buildGlossaryHint() {
  if (!GLOSSARY.size) return "";
  const lines = [...GLOSSARY].map(([term, note]) => `${term} → ${note}`).join("\n");
  return `\n\n指定詞彙對照表（以下詞彙翻譯時必須照這樣處理，不可自行更改）：\n${lines}`;
}
// ─── 🗂 翻譯快取：同一句話（同語言模式下）翻過一次就記住，下次直接回傳，不用再呼叫 API，
// 省費用也省時間；只存在記憶體，重新部署會清空，上限 500 筆（滿了就丟最舊的） ───
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 500;
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
function verifyLineSignature(req, res, next) {
  const sig = req.headers["x-line-signature"];
  if (!sig) return res.status(401).send("Missing signature");
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest("base64");
  if (hash !== sig) return res.status(401).send("Invalid signature");
  next();
}
// ─── 統一的 Claude API 呼叫：失敗（逾時／過載／暫時性錯誤）會自動重試一次，
// 避免單次網路或 API 忙線就直接放棄，大幅降低「翻譯沒反應」的機率 ───
async function callClaudeAPI(payload, timeout, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await axios.post(
        "https://api.anthropic.com/v1/messages",
        payload,
        { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout }
      );
      return r.data;
    } catch (err) {
      lastErr = err;
      const status = err.response ? err.response.status : (err.code || "?");
      console.warn(`[ClaudeAPI] 第 ${attempt + 1} 次呼叫失敗（${status}）${attempt < retries ? "，準備重試" : "，放棄"}`);
      if (attempt < retries) await new Promise(res => setTimeout(res, 1000));
    }
  }
  throw lastErr;
}
async function translateText(text, modeKey) {
  const mode = LANG_MODES[modeKey] || LANG_MODES.ZH_TH_EN;
  const cacheKey = `${modeKey}::${text}`;
  if (translationCache.has(cacheKey)) {
    console.log("[Translate] 快取命中，不呼叫 API");
    return translationCache.get(cacheKey);
  }
  // 翻譯是整個機器人最重要的功能，失敗容忍度要拉高：最多重試 2 次（共 3 次嘗試）
  const data = await callClaudeAPI(
    { model: "claude-sonnet-5-5", max_tokens: 1024, system: mode.system + buildGlossaryHint(), messages: [{ role: "user", content: text }] },
    20000,
    2
  );
  const translated = data.content[0].text;
  translationCache.set(cacheKey, translated);
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    translationCache.delete(translationCache.keys().next().value);
  }
  return translated;
}
// ─── 翻譯在背景持續重試，絕不在群組顯示任何「翻譯失敗」字樣 ───
// translateText 本身已經會重試 2 次；如果連這樣都失敗（通常是 Claude API 當下嚴重壅塞），
// 不要放棄、也不要回一句錯誤訊息嚇到使用者，而是在背景按 5 秒、15 秒、30 秒、60 秒、60 秒
// 的間隔再試，一旦成功就用 push 把翻譯補發過去；全部重試完還是失敗（非常罕見），只記在後台
// log，群組裡完全不會看到任何提示文字。
const BACKGROUND_RETRY_DELAYS = [5000, 15000, 30000, 60000, 60000];
async function translateInBackgroundAndPush(stripped, modeKey, sourceId) {
  for (const delay of BACKGROUND_RETRY_DELAYS) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const translated = await translateText(stripped, modeKey);
      await pushMessage(sourceId, [{ type: "text", text: translated }]);
      console.log("[Translate Background] 補發成功:", stripped.substring(0, 50));
      return;
    } catch (err) {
      console.error("[Translate Background ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
  console.error("[Translate Background] 多次重試後仍然失敗，放棄（群組裡不會顯示任何訊息）：", stripped.substring(0, 50));
}
// ─── 📷 泰文照片翻譯：下載 LINE 圖片內容，用 Claude 視覺能力讀出泰文並翻譯 ───
async function translateThaiImage(base64Image, mediaType) {
  const data = await callClaudeAPI(
    {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      system: "你是專業泰文翻譯。使用者會傳一張圖片，裡面可能包含泰文文字（例如公告、收據、合約、對話截圖等）。請仔細讀出圖片中所有泰文文字，並翻譯成繁體中文，直接輸出翻譯結果，不用加「以下是翻譯」之類的開場白或其他說明。如果圖片中完全沒有偵測到泰文文字，就只回覆「⚠️ 這張圖片沒有偵測到泰文文字」，不要翻譯圖片中的其他語言。" + buildGlossaryHint(),
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          { type: "text", text: "請讀出並翻譯這張圖片裡的泰文內容" },
        ],
      }],
    },
    45000
  );
  return data.content[0].text;
}
async function replyMessages(replyToken, messages, quoteToken = null) {
  if (quoteToken && messages.length > 0) { const ft = messages.find(m => m.type === "text"); if (ft) ft.quoteToken = quoteToken; }
  const r = await axios.post("https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" }, timeout: 10000 }
  );
  console.log("[LINE Reply] status:", r.status);
}
function getSourceId(event) {
  const src = event.source;
  if (src.type === "group") return src.groupId;
  if (src.type === "room") return src.roomId;
  return src.userId;
}
app.post("/webhook", verifyLineSignature, async (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];
  console.log("[Webhook] events count:", events.length);
  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    // 全形「＠」跟半形「@」都當同一個指令符號看待（手機中文輸入法常常會打出全形的＠）
    const text = event.message.text.trim().replace(/＠/g, "@");
    const replyToken = event.replyToken;
    const quoteToken = event.message.quoteToken || null;
    const userId = event.source?.userId || "";
    const sourceId = getSourceId(event);
    const isAdmin = ADMIN_IDS.includes(userId);
    console.log("[Message]", text, "| userId:", userId, "| sourceId:", sourceId);
    await getOrCreateGroup(sourceId, event.source);
    touchGroup(sourceId);
    try {
      // 📋 @目錄（精簡版：機器人現在只專注翻譯＋定時提醒兩個功能）
      if (["@目錄", "@选单", "@選單", "@menu", "@產品目錄"].includes(text)) {
        const curMode = LANG_MODES[getGroupMode(sourceId)];
        await replyMessages(replyToken, [{
          type: "text",
          text: `📋 富林 LINE 機器人\n\n🌐 翻譯功能：${curMode.desc}\n開/關：@開翻譯　@關翻譯\n切換語言：@語言設定\n查看詞彙庫：@詞彙庫\n📷 回覆/引用泰文照片 + @翻照片　自動翻譯照片裡的泰文\n\n⏰ 定時提醒（管理員）：\n@定時提醒 08:30 內容\n查看：@提醒列表　@全部提醒`
        }], quoteToken);
        continue;
      }
      // 🔑 @myid
      if (["@myid", "@我的id"].includes(text.toLowerCase())) {
        await replyMessages(replyToken, [{ type: "text", text: `🔑 你的 LINE userId：\n${userId}\n\n📌 群組 ID：\n${sourceId}` }], quoteToken);
        continue;
      }
      // 👮 白名單管理
      if (text.startsWith("@加白名單")) {
        if (!isAdmin) { await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken); continue; }
        const tid = text.split(/\s+/)[1] || "";
        if (!tid.startsWith("U")) { await replyMessages(replyToken, [{ type: "text", text: "⚠️ 格式：@加白名單 U1234..." }], quoteToken); continue; }
        allowedUsers.add(tid);
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: `✅ 已新增白名單：${tid}` }], quoteToken);
        continue;
      }
      if (text.startsWith("@移除白名單")) {
        if (!isAdmin) { await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken); continue; }
        const tid = text.split(/\s+/)[1] || "";
        allowedUsers.delete(tid);
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: `✅ 已移除：${tid}` }], quoteToken);
        continue;
      }
      if (["@白名單列表", "@whitelist"].includes(text)) {
        if (!isAdmin) { await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken); continue; }
        const list = [...allowedUsers];
        await replyMessages(replyToken, [{ type: "text", text: list.length ? `📋 白名單（${list.length} 人）：\n\n${list.join("\n")}` : "📋 白名單目前為空（全部放行）" }], quoteToken);
        continue;
      }
      // 🔄 翻譯開關
      if (["@開翻譯", "@翻譯開"].includes(text)) {
        translateEnabled.set(sourceId, true);
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 翻譯功能已開啟" }], quoteToken);
        continue;
      }
      if (["@關翻譯", "@翻譯關"].includes(text)) {
        translateEnabled.set(sourceId, false);
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "🔇 翻譯功能已關閉\n\n傳 @開翻譯 重新啟動" }], quoteToken);
        continue;
      }
      if (["@翻譯狀態", "@翻译状态"].includes(text)) {
        const on = isTranslateOn(sourceId);
        const cur = LANG_MODES[getGroupMode(sourceId)];
        await replyMessages(replyToken, [{
          type: "text",
          text: `${on ? "✅ 翻譯：開啟中" : "🔇 翻譯：關閉"}\n🌐 語言模式：【${cur.name}】${cur.desc}`
        }], quoteToken);
        continue;
      }
      // 🌐 語言模式切換
      if (["@語言設定", "@語言模式"].includes(text)) {
        const cur = getGroupMode(sourceId);
        const curMode = LANG_MODES[cur];
        await replyMessages(replyToken, [{
          type: "text",
          text: `🌐 目前語言模式：【${curMode.name}】\n${curMode.desc}\n\n${"─".repeat(18)}\n可切換模式：\n\n@開中泰英　中文↔泰文↔英文（預設）\n@開印尼中英　印尼文↔中文↔英文\n@開中英　中文↔英文\n@開中緬英　中文↔緬甸文↔英文\n@開中緬英泰　中文↔緬甸文↔英文↔泰文`
        }], quoteToken);
        continue;
      }
      if (["@開中泰英", "@預設語言"].includes(text)) {
        groupLangMode.set(sourceId, "ZH_TH_EN");
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 語言模式：中泰英\n🇹🇼 中文 ↔ 🇹🇭 泰文 ↔ 🇺🇸 英文" }], quoteToken);
        continue;
      }
      if (["@開印尼中英", "@印尼模式"].includes(text)) {
        groupLangMode.set(sourceId, "ID_ZH_EN");
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 語言模式：印尼中英\n🇮🇩 印尼文 ↔ 🇹🇼 中文 ↔ 🇺🇸 英文" }], quoteToken);
        continue;
      }
      if (["@開中英", "@中英模式"].includes(text)) {
        groupLangMode.set(sourceId, "ZH_EN");
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 語言模式：中英\n🇹🇼 中文 ↔ 🇺🇸 英文" }], quoteToken);
        continue;
      }
      if (["@開中緬英", "@緬甸模式"].includes(text)) {
        groupLangMode.set(sourceId, "ZH_MY_EN");
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 語言模式：中緬英\n🇹🇼 中文 ↔ 🇲🇲 緬甸文 ↔ 🇺🇸 英文" }], quoteToken);
        continue;
      }
      if (["@開中緬英泰", "@中緬泰模式"].includes(text)) {
        groupLangMode.set(sourceId, "ZH_MY_EN_TH");
        saveState();
        await replyMessages(replyToken, [{ type: "text", text: "✅ 語言模式：中緬英泰\n🇹🇼 中文 ↔ 🇲🇲 緬甸文 ↔ 🇺🇸 英文 ↔ 🇹🇭 泰文" }], quoteToken);
        continue;
      }
      // ════════════════════════════════════════
      // ⏰ 定時提醒（管理員，公開發群組 @all）
      // ════════════════════════════════════════
      // @定時提醒 08:30 記得打卡
      if (text.startsWith("@定時提醒")) {
        if (!isAdmin) continue;
        const match = text.match(/^@定時提醒\s+(\d{1,2}):(\d{2})\s+(.+)$/);
        if (!match) {
          await pushMessage(userId, [{
            type: "text",
            text: "⚠️ 格式錯誤\n\n正確格式：\n@定時提醒 08:30 記得打卡\n@定時提醒 18:00 今日工作回報\n\n時間為台灣時間（24小時制）"
          }]);
          continue;
        }
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2]);
        const msg = match[3].trim();
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          await pushMessage(userId, [{ type: "text", text: "⚠️ 時間格式錯誤，請輸入 00:00 ~ 23:59" }]);
          continue;
        }
        if (!groupReminders.has(sourceId)) groupReminders.set(sourceId, []);
        const list = groupReminders.get(sourceId);
        const newReminder = { id: reminderIdCounter++, hour, minute, message: msg, timerId: null };
        list.push(newReminder);
        scheduleReminder(sourceId, newReminder);
        saveState();
        const g = await getOrCreateGroup(sourceId, event.source);
        console.log(`[Reminder] 新增 #${newReminder.id} | 群組：${g.name} | 時間：${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} | 內容：${msg}`);
        await pushMessage(userId, [{
          type: "text",
          text: `⏰ 定時提醒已設定 #${newReminder.id}\n群組：【${g.name}】\n時間：每天 ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}（台灣時間）\n內容：${msg}\n\n傳 @提醒列表 查看所有提醒`
        }]);
        continue;
      }
      // @提醒列表
      if (["@提醒列表", "@定時列表"].includes(text)) {
        if (!isAdmin) continue;
        const list = groupReminders.get(sourceId) || [];
        if (!list.length) {
          await pushMessage(userId, [{ type: "text", text: "📋 此群組目前沒有設定定時提醒" }]);
        } else {
          const g = await getOrCreateGroup(sourceId, event.source);
          let msg = `⏰ 【${g.name}】定時提醒（${list.length} 筆）\n\n`;
          list.forEach(r => {
            msg += `#${r.id} ${String(r.hour).padStart(2,'0')}:${String(r.minute).padStart(2,'0')} 每天\n　${r.message}\n\n`;
          });
          msg += "傳 @刪除提醒 編號 可刪除";
          await pushMessage(userId, [{ type: "text", text: msg.trim() }]);
        }
        continue;
      }
      // @全部提醒 —— 管理員在任何地方（含私訊）都能一次看到所有群組的提醒
      if (["@全部提醒", "@所有提醒"].includes(text)) {
        if (!isAdmin) continue;
        let totalCount = 0;
        let msg = `⏰ 全部群組定時提醒\n${"═".repeat(20)}\n`;
        for (const [srcId, list] of groupReminders) {
          if (!list.length) continue;
          const g = groups.get(srcId);
          const gName = g ? g.name : srcId.substring(0, 8) + "...";
          msg += `\n【${gName}】\n`;
          list.forEach(r => {
            msg += `#${r.id} ${String(r.hour).padStart(2,'0')}:${String(r.minute).padStart(2,'0')} 每天　${r.message}\n`;
            totalCount++;
          });
        }
        if (totalCount === 0) {
          await pushMessage(userId, [{ type: "text", text: "📋 目前沒有任何群組設定定時提醒" }]);
        } else {
          msg += `\n${"═".repeat(20)}\n共 ${totalCount} 筆提醒`;
          await pushMessage(userId, [{ type: "text", text: msg.trim() }]);
        }
        continue;
      }
      // @刪除提醒 1
      if (text.startsWith("@刪除提醒")) {
        if (!isAdmin) continue;
        const num = parseInt(text.replace(/^@刪除提醒\s*/, "").trim());
        const list = groupReminders.get(sourceId) || [];
        const idx = list.findIndex(r => r.id === num);
        if (idx === -1) {
          await pushMessage(userId, [{ type: "text", text: `⚠️ 找不到提醒 #${num}，傳 @提醒列表 確認編號` }]);
          continue;
        }
        const removed = list.splice(idx, 1)[0];
        if (removed.timerId) clearTimeout(removed.timerId);
        saveState();
        await pushMessage(userId, [{ type: "text", text: `✅ 已刪除定時提醒 #${removed.id}\n${String(removed.hour).padStart(2,'0')}:${String(removed.minute).padStart(2,'0')} ${removed.message}` }]);
        continue;
      }
      if (text.startsWith("@命名")) {
        if (!isAdmin) continue;
        const name = text.replace(/^@命名\s*/, "").trim();
        if (!name) { await pushMessage(userId, [{ type: "text", text: "⚠️ 格式：@命名 王先生報價群" }]); continue; }
        const g = await getOrCreateGroup(sourceId, event.source); g.name = name;
        saveState();
        await pushMessage(userId, [{ type: "text", text: `✅ 群組名稱已更新為：【${name}】` }]);
        continue;
      }
      // 📖 詞彙庫管理（管理員，群組靜默，結果私訊回傳）
      if (text.startsWith("@加詞彙")) {
        if (!isAdmin) continue;
        const body = text.replace(/^@加詞彙\s*/, "").trim();
        const eqIdx = body.indexOf("=");
        if (eqIdx === -1) {
          await pushMessage(userId, [{
            type: "text",
            text: "⚠️ 格式：@加詞彙 原文=翻譯方式\n\n例如：\n@加詞彙 展翼屋=保留原文，不要翻譯\n@加詞彙 坤敬=Khon Kaen（泰國東北府名）"
          }]);
          continue;
        }
        const term = body.slice(0, eqIdx).trim();
        const note = body.slice(eqIdx + 1).trim();
        if (!term || !note) { await pushMessage(userId, [{ type: "text", text: "⚠️ 格式：@加詞彙 原文=翻譯方式" }]); continue; }
        GLOSSARY.set(term, note);
        translationCache.clear();
        saveState();
        await pushMessage(userId, [{ type: "text", text: `✅ 已新增詞彙：${term} → ${note}` }]);
        continue;
      }
      if (["@詞彙庫", "@詞彙列表"].includes(text)) {
        if (!isAdmin) continue;
        if (!GLOSSARY.size) { await pushMessage(userId, [{ type: "text", text: "📖 目前詞彙庫是空的" }]); continue; }
        const list = [...GLOSSARY].map(([term, note]) => `• ${term} → ${note}`).join("\n");
        await pushMessage(userId, [{ type: "text", text: `📖 詞彙庫（共 ${GLOSSARY.size} 筆）：\n\n${list}\n\n傳 @刪除詞彙 原文 可刪除` }]);
        continue;
      }
      if (text.startsWith("@刪除詞彙")) {
        if (!isAdmin) continue;
        const term = text.replace(/^@刪除詞彙\s*/, "").trim();
        if (!GLOSSARY.has(term)) { await pushMessage(userId, [{ type: "text", text: `⚠️ 詞彙庫裡沒有「${term}」，傳 @詞彙庫 查看目前清單` }]); continue; }
        GLOSSARY.delete(term);
        translationCache.clear();
        saveState();
        await pushMessage(userId, [{ type: "text", text: `✅ 已刪除詞彙：${term}` }]);
        continue;
      }
      // 📷 泰文照片翻譯 —— 對著含泰文的照片「回覆／引用」傳 @翻照片，才會花費用 OCR + 翻譯
      if (["@翻照片", "@翻譯照片", "@翻泰文照片"].includes(text)) {
        const quotedId = event.message.quotedMessageId;
        if (!quotedId) {
          await replyMessages(replyToken, [{ type: "text", text: "⚠️ 請先「回覆／引用」那張含泰文的照片，再傳 @翻照片" }], quoteToken);
          continue;
        }
        try {
          console.log("[ImageTranslate] quotedId:", quotedId, "| sourceId:", sourceId);
          const imgResp = await axios.get(`https://api-data.line.me/v2/bot/message/${quotedId}/content`, {
            headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            responseType: "arraybuffer",
            timeout: 30000,
          });
          const mediaType = (imgResp.headers["content-type"] || "image/jpeg").split(";")[0].trim();
          const base64Image = Buffer.from(imgResp.data).toString("base64");
          console.log("[ImageTranslate] sourceId:", sourceId, "| mediaType:", mediaType, "| bytes:", imgResp.data.length);
          const translated = await translateThaiImage(base64Image, mediaType);
          await replyMessages(replyToken, [{ type: "text", text: translated }], quoteToken);
        } catch (err) {
          const status = err.response ? err.response.status : (err.code || "?");
          const detail = err.response ? JSON.stringify(err.response.data) : err.message;
          console.error("[ImageTranslate ERROR]", status, detail);
          await replyMessages(replyToken, [{ type: "text", text: `⚠️ 讀取圖片失敗（錯誤代碼：${status}），請確認引用的是一張圖片訊息，或稍後再試一次` }], quoteToken);
        }
        continue;
      }
      // 🌐 翻譯
      if (!isTranslateOn(sourceId)) continue;
      if (!/[\p{L}\p{M}]/u.test(text)) continue;
      // @人名標記不一定在開頭，也常常夾在句子中間（例如「555 @Tam 來丟垃圾也要去喔」），
      // 之前只處理「開頭」的連續 @標記，像這種中間才出現 @名字的句子，@Tam 會原封不動
      // 混進送給 Claude 的內容，容易讓翻譯結果變得奇怪，甚至讓 Claude 誤判成「只是提及、
      // 沒有實質內容」而完全不回應，訊息就這樣消失。
      // 這裡改成不管 @標記出現在句子的哪個位置，一律全部清掉，只留下真正要翻譯的句子本身，
      // 確保不管人名標記在前面、後面還是中間，句子都一定會被乾淨地送出並翻譯到。
      const stripped = text.replace(/@\S+\s*/g, "").trim();
      if (!stripped || !/[\p{L}\p{M}]/u.test(stripped)) continue;
      // 純「(人名)」標註＋表情符號（例如 @Ann (林美玉)🙌✌）不是真的要翻譯的內容，
      // 先濾掉括號內容跟表情符號，剩下沒有實質文字就直接跳過，不要送去給 Claude，
      // 避免它回一句「這個訊息只有名字和表情符號…」這種不該出現在群組的說明文字。
      const forTranslateCheck = stripped
        .replace(/[\(（][^)）]*[\)）]/g, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/[‍️]/g, "")
        .trim();
      if (!forTranslateCheck || !/[\p{L}\p{M}]/u.test(forTranslateCheck)) continue;
      const modeKey = getGroupMode(sourceId);
      console.log("[Translate] mode:", modeKey, "input:", stripped.substring(0,50));
      // 翻譯絕對不能在群組顯示任何「失敗」字樣，也不能就這樣消失不見：
      // 1) translateText 本身已經會重試 2 次，先盡量在這裡直接用 reply 立即回覆，
      // 2) reply 失敗（常見是處理太久、replyToken 過期）就改用 push 補發，
      // 3) 連第 1) 步都失敗，交給背景持續重試（translateInBackgroundAndPush），
      //    不等待、不卡住後面訊息的處理，成功就 push 補發，群組裡全程不會看到任何錯誤提示。
      try {
        const translated = await translateText(stripped, modeKey);
        console.log("[Translate] output:", translated.substring(0,50));
        try {
          await replyMessages(replyToken, [{ type: "text", text: translated }], quoteToken);
        } catch (replyErr) {
          console.error("[Translate Reply ERROR]", replyErr.response ? JSON.stringify(replyErr.response.data) : replyErr.message);
          pushMessage(sourceId, [{ type: "text", text: translated }]).catch(pushErr => {
            console.error("[Translate Push ERROR]", pushErr.message);
          });
        }
      } catch (translateErr) {
        console.error("[Translate ERROR]", translateErr.response ? JSON.stringify(translateErr.response.data) : translateErr.message);
        translateInBackgroundAndPush(stripped, modeKey, sourceId);
      }
    } catch (err) {
      console.error("[ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
});
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "fulin-line-bot" });
});
(async () => {
  await loadState();
  app.listen(PORT, () => {
    console.log("✅ 富林 LINE 機器人啟動，Port:", PORT);
    console.log("ADMIN_IDS:", ADMIN_IDS.length > 0 ? ADMIN_IDS : "未設定");
    if (!UPSTASH_CONFIGURED) console.log("[State] ⚠️ 未設定 Upstash，群組設定／定時提醒重啟後會遺失");
  });
})();
