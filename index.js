const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");
const app = express();
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.BASE_URL;
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
const ignoredGroups = new Set();
// 全域開關：關掉之後，所有群組都不會再自動記事（不用一個一個群組打 @忽略記事）
const AUTO_RECORD_ENABLED = false;
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
let taskIdCounter = 1;
async function getOrCreateGroup(sourceId, eventSource = null) {
  if (!groups.has(sourceId)) {
    groups.set(sourceId, { name: sourceId.substring(0, 8) + "...", lastActiveAt: new Date(), tasks: [] });
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
function daysSince(date) {
  return Math.floor((new Date() - date) / (1000 * 60 * 60 * 24));
}
function formatLastActive(date) {
  const days = daysSince(date);
  const t = `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
  if (days === 0) return `今天 ${t}`;
  if (days === 1) return `昨天 ${t}`;
  return `${String(date.getMonth()+1).padStart(2,"0")}/${String(date.getDate()).padStart(2,"0")} ${t}`;
}
function getGroupTasksText(sourceId) {
  const g = groups.get(sourceId);
  if (!g) return "📋 此群組尚無記事";
  const pending = g.tasks.filter(t => !t.done);
  const done = g.tasks.filter(t => t.done);
  if (!pending.length && !done.length) return "📋 此群組目前沒有任何記事";
  let msg = `📋【${g.name}】記事\n`;
  if (pending.length) { msg += `\n⏳ 未完成（${pending.length} 件）\n`; pending.forEach(t => { msg += `  ${t.id}. ${t.text}\n`; }); }
  if (done.length) { msg += `\n✅ 已完成（${done.length} 件）\n`; done.forEach(t => { msg += `  ✔ ${t.text}\n`; }); }
  return msg.trim();
}
function buildDailyReport() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getDate()).padStart(2,"0")}`;
  const active = [], day1 = [], day2 = [];
  for (const [sourceId, g] of groups) {
    const pending = g.tasks.filter(t => !t.done);
    if (!pending.length) continue;
    const days = daysSince(g.lastActiveAt);
    if (days === 0) active.push({ g, pending });
    else if (days === 1) day1.push({ g, pending });
    else if (days === 2) day2.push({ g, pending });
  }
  const total = active.length + day1.length + day2.length;
  const totalTasks = [...active, ...day1, ...day2].reduce((s, x) => s + x.pending.length, 0);
  if (!total) return `📋 每日事項回報 ${dateStr} 18:00\n${"═".repeat(22)}\n\n🎉 目前沒有需要追蹤的事項\n\n${"═".repeat(22)}\n共 0 組 | 0 件待辦`;
  const render = ({ g, pending }) => { let s = `【${g.name}】最後：${formatLastActive(g.lastActiveAt)}\n`; pending.forEach(t => { s += `  ${t.id}. ${t.text}\n`; }); return s; };
  let msg = `📋 每日事項回報 ${dateStr} 18:00\n${"═".repeat(22)}\n`;
  if (active.length) { msg += `\n🔴 今日活躍（${active.length} 組）\n${"─".repeat(20)}\n`; active.forEach(x => { msg += render(x) + "\n"; }); }
  if (day1.length) { msg += `\n🟡 昨日後無新訊息（${day1.length} 組）\n${"─".repeat(20)}\n`; day1.forEach(x => { msg += render(x) + "\n"; }); }
  if (day2.length) { msg += `\n⚪ 2天未說話—明日自動移除（${day2.length} 組）\n${"─".repeat(20)}\n`; day2.forEach(x => { msg += render(x) + "\n"; }); }
  msg += `${"═".repeat(22)}\n共 ${total} 組 | ${totalTasks} 件待辦`;
  return msg;
}
// ─── 讀取 / 儲存持久化設定 ────────────────────────────────────
function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    allowedUsers: [...allowedUsers],
    ignoredGroups: [...ignoredGroups],
    translateEnabled: Object.fromEntries(translateEnabled),
    groupLangMode: Object.fromEntries(groupLangMode),
    taskIdCounter,
    reminderIdCounter,
    groups: Object.fromEntries(
      [...groups].map(([sourceId, g]) => [sourceId, {
        name: g.name,
        lastActiveAt: g.lastActiveAt instanceof Date ? g.lastActiveAt.toISOString() : g.lastActiveAt,
        tasks: g.tasks.map(t => ({
          ...t,
          createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
          doneAt: t.doneAt instanceof Date ? t.doneAt.toISOString() : t.doneAt,
        })),
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
    (data.ignoredGroups || []).forEach(id => ignoredGroups.add(id));
    Object.entries(data.translateEnabled || {}).forEach(([id, v]) => translateEnabled.set(id, v));
    Object.entries(data.groupLangMode || {}).forEach(([id, mode]) => groupLangMode.set(id, mode));
    if (typeof data.taskIdCounter === "number") taskIdCounter = data.taskIdCounter;
    if (typeof data.reminderIdCounter === "number") reminderIdCounter = data.reminderIdCounter;
    Object.entries(data.groups || {}).forEach(([sourceId, g]) => {
      groups.set(sourceId, {
        name: g.name,
        lastActiveAt: g.lastActiveAt ? new Date(g.lastActiveAt) : new Date(),
        tasks: (g.tasks || []).map(t => ({
          ...t,
          createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
          doneAt: t.doneAt ? new Date(t.doneAt) : undefined,
        })),
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
// 注意：每日自動回報已取消（會額外消耗 LINE Push 訊息額度），
// 改成純被動：想看的時候自己傳 @今日報告／@報告 即可，buildDailyReport() 仍保留給這個指令用。
app.use("/images", express.static(path.join(__dirname, "public/images")));
function img(f) { return BASE_URL + "/images/" + encodeURIComponent(f); }
const PRODUCTS = {
  "黑框木紋": { label: "黑框木紋 ★熱門★", description: "黑色鐵框搭配木紋面板，工業風與自然感完美融合\n尺寸：多規格可選\n\n▶️ 影片：https://youtu.be/Xqw4Utll1yk\n📩 如需報價請洽詢", images: ["https://img.youtube.com/vi/Xqw4Utll1yk/maxresdefault.jpg", img("黑框木紋_02.png"), img("黑框木紋_03.jpg")] },
  "白框木紋": { label: "白框木紋", description: "清爽白框搭配木紋面板，現代簡約風格\n📩 如需報價請洽詢", images: [img("白框木紋_01.jpg"), img("白框木紋_02.jpg"), img("白框木紋_03.jpg")] },
  "白框白板": { label: "白框白板", description: "全白簡潔設計，適合醫療、辦公空間\n📩 如需報價請洽詢", images: [img("白框白板_01.jpg"), img("白框白板_02.jpg"), img("白框白板_03.jpg")] },
  "白框灰黑": { label: "白框灰黑", description: "白框搭配灰黑面板，時尚對比設計\n📩 如需報價請洽詢", images: [img("白框灰黑_01.jpg"), img("白框灰黑_02.jpg"), img("白框灰黑_03.jpg")] },
  "黑框白板": { label: "黑框白板", description: "黑框白面，俐落高對比設計\n📩 如需報價請洽詢", images: [img("黑框白板_01.jpg"), img("黑框白板_02.jpg"), img("黑框白板_03.jpg")] },
  "黑框灰黑": { label: "黑框灰黑", description: "全黑深色調，沉穩低調的進階選擇\n📩 如需報價請洽詢", images: [img("黑框灰黑_01.jpg"), img("黑框灰黑_02.jpg"), img("黑框灰黑_03.jpg")] },
  "大衛浴": { label: "大衛浴 120x190x220", description: "尺寸：120x190x220 cm\n寬敞舒適，適合主臥衛浴規劃\n📩 如需報價請洽詢", images: [img("大衛浴_01.png"), img("大衛浴_02.jpg"), img("大衛浴_03.jpg")] },
  "小衛浴": { label: "小衛浴 110x140x220", description: "尺寸：110x140x220 cm\n緊湊高效，適合次臥或公共衛浴\n📩 如需報價請洽詢", images: [img("小衛浴_01.jpg"), img("小衛浴_02.jpg"), img("小衛浴_03.png")] },
  "水泥廁所": { label: "水泥廁所", description: "清水模質感，工業Loft風格\n耐用低維護，適合商業空間\n📩 如需報價請洽詢", images: [img("水泥廁所_01.jpg"), img("水泥廁所_02.jpg"), img("水泥廁所_03.jpg")] },
  "室外衛浴": { label: "室外衛浴", description: "防水耐候設計，適合戶外、露營區、工地\n📩 如需報價請洽詢", images: [img("室外衛浴_01.jpg"), img("室外衛浴_02.jpg"), img("室外衛浴_03.jpg")] },
  "貼磁衛浴": { label: "貼磁衛浴 1.7x2.3x2", description: "磁磚貼面，質感精緻，適合住宅與飯店\n📩 如需報價請洽詢", images: [img("貼磁衛浴_01.jpg"), img("貼磁衛浴_02.jpg"), img("貼磁衛浴_03.jpg")] },
  "日式衛浴": { label: "日式衛浴", description: "石紋壁板、黑框玻璃、頂噴花灑，質感飯店級\n含馬桶、洗手台、淋浴間\n📩 如需報價請洽詢", images: [img("日式衛浴_01.jpg"), img("日式衛浴_03.jpg"), img("日式衛浴_04.jpg")] },
  "二樓": { label: "組合屋 2.1 二樓", description: "2.1m 樓高，靈活空間規劃\n📩 如需報價請洽詢", images: [img("二樓_01.jpg"), img("二樓_02.png"), img("二樓_03.jpg")] },
  "三樓": { label: "組合屋 2.1 三樓", description: "2.1m 樓高三層設計\n📩 如需報價請洽詢", images: [img("三樓_01.jpg"), img("三樓_02.jpg"), img("三樓_03.jpg")] },
  "展翼屋": { label: "10呎展翼屋", description: "創新展翼設計，快速展開即可使用\n含衛浴間、水槽\n📩 如需報價請洽詢", images: [img("展翼屋_01.jpg"), img("展翼屋_02.jpg"), img("展翼屋_03.jpg")] },
  "20呎展翼屋": { label: "20呎展翼屋", description: "加大版展翼設計，空間更寬敞\n📩 如需報價請洽詢", images: [img("展翼屋20_01.jpg"), img("展翼屋20_02.jpg"), img("展翼屋20_03.jpg")] },
  "折疊屋": { label: "折疊屋", description: "快速折疊展開，吊車即可定位安裝\n📩 如需報價請洽詢", images: [img("折疊屋_01.jpg"), img("折疊屋_02.jpg"), img("折疊屋_03.jpg")] },
  "宿舍": { label: "組合屋宿舍", description: "大規模多人住宿首選\n📩 如需報價請洽詢", images: [img("宿舍_01.jpg"), img("宿舍_02.jpg"), img("宿舍_03.jpg")] },
  "廚具": { label: "廚具", description: "組合屋專用廚具，多款風格可選\n📩 如需報價請洽詢", images: [img("廚具_01.jpg"), img("廚具_02.jpg"), img("廚具_03.jpg")] },
  "SPC地板": { label: "SPC地板", description: "石塑防水耐磨地板，組合屋首選\n色號：826暖灰、809薄荷、819冷灰\n📩 如需報價請洽詢", images: [img("SPC地板_01.jpg"), img("SPC地板_02.jpg"), img("SPC地板_03.jpg")] },
  "三合一門": { label: "三合一門", description: "氣密、隔熱、防盜三效合一\n📩 如需報價請洽詢", images: [img("三合一門_01.jpg"), img("三合一門_02.jpg"), img("三合一門_01.jpg")] },
  "標準窗": { label: "標準窗", description: "組合屋標配推拉窗，附紗窗\n📩 如需報價請洽詢", images: [img("標準窗_01.png"), img("標準窗_02.jpg"), img("標準窗_02.jpg")] },
  "沙門": { label: "沙門（安全紗門）", description: "菱格鐵網安全紗門，通風防盜兼顧\n📩 如需報價請洽詢", images: [img("沙門_01.png"), img("沙門_01.png"), img("沙門_01.png")] },
  "DM": { label: "富林組合屋 產品DM", description: "富林組合屋\n雲林縣二崙鄉楊賢路143號\n\n單顆入門基礎款（1門2窗）\n3mx6m  NT$98,000\n4mx6m  NT$118,000\n4mx8m  NT$156,000\n\n衛浴加購\n大衛浴 NT$55,000\n小衛浴 NT$40,000\n\n廖先生 0929-010-882\nLine：@aa168", images: [img("DM_01.jpg"), img("DM_02.jpg"), img("DM_03.jpg")] },
};
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
function verifyLineSignature(req, res, next) {
  const sig = req.headers["x-line-signature"];
  if (!sig) return res.status(401).send("Missing signature");
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest("base64");
  if (hash !== sig) return res.status(401).send("Invalid signature");
  next();
}
function detectProduct(text) {
  for (const key of Object.keys(PRODUCTS)) { if (text.includes("@" + key)) return PRODUCTS[key]; }
  return null;
}
async function translateText(text, modeKey) {
  const mode = LANG_MODES[modeKey] || LANG_MODES.ZH_TH_EN;
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-sonnet-5-5", max_tokens: 1024, system: mode.system, messages: [{ role: "user", content: text }] },
    { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 15000 }
  );
  return r.data.content[0].text;
}
// ─── 📷 泰文照片翻譯：下載 LINE 圖片內容，用 Claude 視覺能力讀出泰文並翻譯 ───
async function translateThaiImage(base64Image, mediaType) {
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      system: "你是專業泰文翻譯。使用者會傳一張圖片，裡面可能包含泰文文字（例如公告、收據、合約、對話截圖等）。請仔細讀出圖片中所有泰文文字，並翻譯成繁體中文，直接輸出翻譯結果，不用加「以下是翻譯」之類的開場白或其他說明。如果圖片中完全沒有偵測到泰文文字，就只回覆「⚠️ 這張圖片沒有偵測到泰文文字」，不要翻譯圖片中的其他語言。",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          { type: "text", text: "請讀出並翻譯這張圖片裡的泰文內容" },
        ],
      }],
    },
    { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 45000 }
  );
  return r.data.content[0].text;
}
// ─── 🤖 @aafulin 智能問答（像 @meta.ai 那樣，什麼都能問，需要即時資訊會自動上網查證） ───
async function askAI(question) {
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      system: `你是「aafulin」，一個親切、聰明、講話直接的中文 AI 助理，個性自然不制式，像朋友一樣聊天。
使用者會用「@aafulin 問題」跟你互動，內容可能是問路、找店家/地址、查天氣、查資料、算數學、閒聊等任何問題，不管問什麼都要盡力回答。

規則：
1. 只要問題牽涉到地點、地址、營業時間、電話、目前新聞、天氣、價格等「需要查證的即時資訊」，一律使用 web_search 工具實際查證後再回答，不可以憑印象亂猜地址、電話或資訊。
2. 若使用者問「這附近」、「我這邊」等但沒說明是哪個縣市/地區，先反問對方所在地區，不要瞎猜地點。
3. 回答要簡短口語，像朋友在 LINE 聊天，不要用 markdown 標題、條列符號或粗體，用簡單句子或換行即可，盡量在 5-6 行內講完。
4. 查不到明確資訊時要老實說查不到，不要編造地址或內容。
5. 用繁體中文回覆，除非對方明顯用其他語言提問。`,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
          user_location: { type: "approximate", country: "TW", timezone: "Asia/Taipei" },
        },
      ],
      messages: [{ role: "user", content: question }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 45000,
    }
  );
  const blocks = r.data.content || [];
  const answer = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return answer || "抱歉，這題我暫時查不到明確答案，你可以換個問法再問我一次。";
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
      // 📋 @目錄
      if (["@目錄", "@选单", "@選單", "@menu", "@產品目錄"].includes(text)) {
        const curMode = LANG_MODES[getGroupMode(sourceId)];
        await replyMessages(replyToken, [{
          type: "text",
          text: `📋 富林組合屋 產品目錄\n（輸入 @品名 查詢詳情）\n\n🏠 框架顏色搭配：\n@黑框木紋　@黑框白板　@黑框灰黑\n@白框木紋　@白框白板　@白框灰黑\n\n🚿 衛浴系列：\n@大衛浴　@小衛浴　@水泥廁所\n@室外衛浴　@貼磁衛浴　@日式衛浴\n\n🏢 屋型系列：\n@二樓　@三樓　@展翼屋　@20呎展翼屋\n@折疊屋　@宿舍\n\n🛋 配件系列：\n@廚具　@SPC地板　@三合一門　@標準窗　@沙門\n\n📩 完整 DM 報價：\n@DM\n\n${"─".repeat(18)}\n🌐 翻譯功能：${curMode.desc}\n@語言設定 查看/切換語言模式\n📷 回覆/引用泰文照片 + @翻照片　自動翻譯照片裡的泰文\n\n🤖 想問任何問題就打：@aafulin 你的問題`
        }], quoteToken);
        continue;
      }
      // 📞 @聯絡
      if (["@聯絡", "@contact", "@联絡"].includes(text)) {
        await replyMessages(replyToken, [{ type: "text", text: `📞 富林工程\n\n服務專線 0929-010-882\nLine：@aa168\n地址：臺南市成功里143號\n\n歡迎加入 Line 洽詢，提供1對1報價服務！` }], quoteToken);
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
      // 📝 記事系統（管理員，群組靜默）
      if (["@忽略記事", "@忽略"].includes(text)) {
        if (!isAdmin) continue;
        ignoredGroups.add(sourceId);
        saveState();
        const g = await getOrCreateGroup(sourceId, event.source);
        await pushMessage(userId, [{ type: "text", text: `🚫 【${g.name}】已設為忽略\n傳 @恢復記事 可重新啟用` }]);
        continue;
      }
      if (["@恢復記事", "@恢復"].includes(text)) {
        if (!isAdmin) continue;
        ignoredGroups.delete(sourceId);
        saveState();
        const g = await getOrCreateGroup(sourceId, event.source);
        await pushMessage(userId, [{ type: "text", text: `✅ 【${g.name}】已恢復自動記事` }]);
        continue;
      }
      if (["@忽略列表"].includes(text)) {
        if (!isAdmin) continue;
        if (!ignoredGroups.size) { await pushMessage(userId, [{ type: "text", text: "📋 目前沒有設定忽略的群組" }]); }
        else { const names = [...ignoredGroups].map(id => { const g = groups.get(id); return g ? `• 【${g.name}】` : `• ${id.substring(0,8)}...`; }).join("\n"); await pushMessage(userId, [{ type: "text", text: `🚫 忽略記事的群組（${ignoredGroups.size} 組）：\n\n${names}` }]); }
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
      // 注意：@事項／@記事列表 的判斷要放在 @記事（新增記事）前面，
      // 不然 "@記事列表".startsWith("@記事") 會是 true，指令會被新增記事攔截，
      // 誤把「列表」兩個字記成一筆記事，而且永遠查不到真正的記事清單。
      if (["@事項", "@記事列表"].includes(text)) {
        if (!isAdmin) continue;
        await pushMessage(userId, [{ type: "text", text: getGroupTasksText(sourceId) }]);
        continue;
      }
      if (text.startsWith("@記事")) {
        if (!isAdmin) continue;
        const content = text.replace(/^@記事\s*/, "").trim();
        if (!content) { await pushMessage(userId, [{ type: "text", text: "⚠️ 格式：@記事 確認報價" }]); continue; }
        const g = await getOrCreateGroup(sourceId, event.source);
        const nt = { id: taskIdCounter++, text: content, done: false, createdAt: new Date() }; g.tasks.push(nt);
        saveState();
        await pushMessage(userId, [{ type: "text", text: `📝 已記錄 #${nt.id}\n群組：【${g.name}】\n內容：「${content}」` }]);
        continue;
      }
      if (text.startsWith("@完成")) {
        if (!isAdmin) continue;
        const num = parseInt(text.replace(/^@完成\s*/, "").trim());
        let found = null; for (const [,g] of groups) { const t = g.tasks.find(t => t.id === num); if (t) { found = t; break; } }
        if (!found) { await pushMessage(userId, [{ type: "text", text: `⚠️ 找不到 #${num}` }]); continue; }
        if (found.done) { await pushMessage(userId, [{ type: "text", text: `ℹ️ #${num} 已經是完成狀態` }]); continue; }
        found.done = true; found.doneAt = new Date();
        saveState();
        await pushMessage(userId, [{ type: "text", text: `✅ #${num} 已完成\n「${found.text}」` }]);
        continue;
      }
      if (text.startsWith("@刪除")) {
        if (!isAdmin) continue;
        const num = parseInt(text.replace(/^@刪除\s*/, "").trim());
        let removed = null; for (const [,g] of groups) { const i = g.tasks.findIndex(t => t.id === num); if (i !== -1) { removed = g.tasks.splice(i,1)[0]; break; } }
        if (!removed) { await pushMessage(userId, [{ type: "text", text: `⚠️ 找不到 #${num}` }]); continue; }
        saveState();
        await pushMessage(userId, [{ type: "text", text: `🗑 #${num} 已刪除\n「${removed.text}」` }]);
        continue;
      }
      if (["@今日報告", "@報告"].includes(text)) {
        if (!isAdmin) continue;
        await pushMessage(userId, [{ type: "text", text: buildDailyReport() }]);
        continue;
      }
      if (text === "@清除已完成") {
        if (!isAdmin) continue;
        let cleared = 0; for (const [,g] of groups) { const b = g.tasks.length; g.tasks = g.tasks.filter(t => !t.done); cleared += b - g.tasks.length; }
        saveState();
        await pushMessage(userId, [{ type: "text", text: `🧹 已清除 ${cleared} 筆已完成記事` }]);
        continue;
      }
      const product = detectProduct(text);
      if (product) {
        const imgs = product.images.filter(u => u && u.startsWith("http")).map(u => ({ type: "image", originalContentUrl: u, previewImageUrl: u }));
        await replyMessages(replyToken, [...imgs, { type: "text", text: product.label + "\n\n" + product.description }], quoteToken);
        continue;
      }
      // 🤖 @aafulin 智能問答 —— 像 @meta.ai 一樣，什麼都能問，不管什麼問題都盡量回答
      const aiMatch = text.match(/^@aafulin[:：]?\s*([\s\S]*)$/i);
      if (aiMatch) {
        const question = aiMatch[1].trim();
        if (!question) {
          await replyMessages(replyToken, [{
            type: "text",
            text: "你好，我是 aafulin 🤖\n直接在後面接你的問題就可以，例如：\n@aafulin 這附近哪裡有賣五金的\n@aafulin 明天台南天氣如何"
          }], quoteToken);
          continue;
        }
        try {
          const answer = await askAI(question);
          await replyMessages(replyToken, [{ type: "text", text: answer }], quoteToken);
        } catch (err) {
          console.error("[AI ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
          await replyMessages(replyToken, [{ type: "text", text: "抱歉，剛剛查詢時出了點問題，請稍後再問我一次。" }], quoteToken);
        }
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
      // 🔔 關鍵字自動記事
      const AUTO_KEYWORDS =["報價","訂購","預約","確認","合約","付款","匯款","多少錢","什麼時候","可以嗎","麻煩","簽約","要訂","幫我","能不能","何時","幾號","幾點","需要","ราคา","สั่ง","นัด","ยืนยัน","เท่าไร","จ่าย","สัญญา","เมื่อไร","ได้ไหม","ช่วย","ต้องการ","อยาก"];
      const hit = AUTO_KEYWORDS.find(kw => text.includes(kw));
      if (AUTO_RECORD_ENABLED && hit && ADMIN_IDS.length > 0 && !isAdmin && !ignoredGroups.has(sourceId)) {
        const g = await getOrCreateGroup(sourceId, event.source);
        const nt = { id: taskIdCounter++, text: text.substring(0,80), done: false, createdAt: new Date(), auto: true }; g.tasks.push(nt);
        saveState();
        const now = new Date(); const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
        ADMIN_IDS.forEach(aid => pushMessage(aid, [{ type: "text", text: `🔔 自動記事 #${nt.id}\n群組：【${g.name}】\n關鍵字：${hit}\n內容：${nt.text}\n時間：${ts}\n\n傳 @完成 ${nt.id} 標記完成` }]));
      }
      // 🌐 翻譯
      if (!isTranslateOn(sourceId)) continue;
      if (!/[\p{L}\p{M}]/u.test(text)) continue;
      const stripped = text.replace(/^@\S+\s*/, "").trim();
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
      try {
        const translated = await translateText(stripped, modeKey);
        console.log("[Translate] output:", translated.substring(0,50));
        await replyMessages(replyToken, [{ type: "text", text: translated }], quoteToken);
      } catch (translateErr) {
        // 翻譯失敗（常見是 Claude API 逾時／暫時過載）：群組裡不顯示錯誤訊息，只記錄在後台 log
        console.error("[Translate ERROR]", translateErr.response ? JSON.stringify(translateErr.response.data) : translateErr.message);
      }
    } catch (err) {
      console.error("[ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
});
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "fulin-line-bot", products: Object.keys(PRODUCTS).length });
});
(async () => {
  await loadState();
  app.listen(PORT, () => {
    console.log("✅ 富林 LINE 機器人啟動，Port:", PORT);
    console.log("ADMIN_IDS:", ADMIN_IDS.length > 0 ? ADMIN_IDS : "未設定");
    if (!UPSTASH_CONFIGURED) console.log("[State] ⚠️ 未設定 Upstash，群組設定／定時提醒重啟後會遺失");
  });
})();
