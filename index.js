

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

// ─── 白名單（從環境變數讀取，逗號分隔） ───────────────────────────
// 管理員 userId（有權限新增/移除白名單）
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map(id => id.trim()).filter(Boolean)
  : [];

// 允許使用的 userId（空白 = 全部放行）
let allowedUsers = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(",").map(id => id.trim()).filter(Boolean))
  : new Set();

// ─── 忽略記事的群組（不觸發自動關鍵字記事） ──────────────────────
const ignoredGroups = new Set();

// key: groupId 或 userId，value: true/false
const translateEnabled = new Map();

function isTranslateOn(sourceId) {
  // 預設開啟，傳 @關翻譯 才關閉
  return translateEnabled.get(sourceId) !== false;
}

// ─── 自動抓取群組名稱（LINE Group Summary API） ───────────────
async function fetchGroupName(groupId) {
  try {
    const r = await axios.get(
      `https://api.line.me/v2/bot/group/${groupId}/summary`,
      {
        headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN },
        timeout: 5000
      }
    );
    return r.data.groupName || groupId.substring(0, 8) + "...";
  } catch (err) {
    console.log("[GroupName] 無法取得群組名稱:", groupId, err.message);
    return groupId.substring(0, 8) + "...";
  }
}

// ─── 記事系統（以群組為單位） ────────────────────────────────────
// groups 結構：Map<sourceId, { name, lastActiveAt, tasks: [{id,text,done,createdAt}] }>
const groups = new Map();
let taskIdCounter = 1;

async function getOrCreateGroup(sourceId, eventSource = null) {
  if (!groups.has(sourceId)) {
    // 先用 ID 暫時命名，再背景抓真實名稱
    groups.set(sourceId, {
      name: sourceId.substring(0, 8) + "...",
      lastActiveAt: new Date(),
      tasks: []
    });
    // 如果是群組類型，背景去抓群組名稱
    if (eventSource && eventSource.type === "group") {
      fetchGroupName(sourceId).then(name => {
        if (groups.has(sourceId)) {
          groups.get(sourceId).name = name;
          console.log("[GroupName] 自動取得群組名稱:", name);
        }
      });
    }
  }
  return groups.get(sourceId);
}

// 更新群組最後活躍時間（每次有人說話時呼叫）
function touchGroup(sourceId) {
  if (groups.has(sourceId)) {
    groups.get(sourceId).lastActiveAt = new Date();
  }
}

// 計算距今天數（0=今天, 1=昨天, 2=前天...）
function daysSince(date) {
  const now = new Date();
  const diffMs = now - date;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// 格式化最後活躍時間顯示
function formatLastActive(date) {
  const days = daysSince(date);
  const timeStr = `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  if (days === 0) return `今天 ${timeStr}`;
  if (days === 1) return `昨天 ${timeStr}`;
  const mmdd = `${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
  return `${mmdd} ${timeStr}`;
}

// 取得單一群組的事項文字
function getGroupTasksText(sourceId) {
  const g = groups.get(sourceId);
  if (!g) return "📋 此群組尚無記事";
  const pending = g.tasks.filter(t => !t.done);
  const done = g.tasks.filter(t => t.done);
  if (pending.length === 0 && done.length === 0) return "📋 此群組目前沒有任何記事";
  let msg = `📋【${g.name}】記事\n`;
  if (pending.length > 0) {
    msg += `\n⏳ 未完成（${pending.length} 件）\n`;
    pending.forEach(t => { msg += `  ${t.id}. ${t.text}\n`; });
  }
  if (done.length > 0) {
    msg += `\n✅ 已完成（${done.length} 件）\n`;
    done.forEach(t => { msg += `  ✔ ${t.text}\n`; });
  }
  return msg.trim();
}

// 每日回報：只顯示 3 天內有活動的群組，按狀態分區
function buildDailyReport() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;

  // 過濾出 3 天內有活動 且 有未完成事項 的群組
  const active   = []; // 今天說過話
  const day1     = []; // 昨天說過
  const day2     = []; // 前天說過（第2天，最後一次出現）

  for (const [sourceId, g] of groups) {
    const pending = g.tasks.filter(t => !t.done);
    if (pending.length === 0) continue; // 沒有未完成事項就跳過
    const days = daysSince(g.lastActiveAt);
    if (days === 0) active.push({ sourceId, g, pending });
    else if (days === 1) day1.push({ sourceId, g, pending });
    else if (days === 2) day2.push({ sourceId, g, pending });
    // days >= 3：不顯示
  }

  const totalGroups = active.length + day1.length + day2.length;
  const totalTasks = [...active, ...day1, ...day2].reduce((s, x) => s + x.pending.length, 0);

  if (totalGroups === 0) {
    return `📋 每日事項回報 ${dateStr} 18:00\n${'═'.repeat(22)}\n\n🎉 目前沒有需要追蹤的事項\n\n${'═'.repeat(22)}\n共 0 組 | 0 件待辦`;
  }

  function renderGroup({ sourceId, g, pending }) {
    let s = `【${g.name}】最後：${formatLastActive(g.lastActiveAt)}\n`;
    pending.forEach(t => { s += `  ${t.id}. ${t.text}\n`; });
    return s;
  }

  let msg = `📋 每日事項回報 ${dateStr} 18:00\n${'═'.repeat(22)}\n`;

  if (active.length > 0) {
    msg += `\n🔴 今日活躍（${active.length} 組）\n${'─'.repeat(20)}\n`;
    active.forEach(x => { msg += renderGroup(x) + "\n"; });
  }

  if (day1.length > 0) {
    msg += `\n🟡 昨日後無新訊息（${day1.length} 組）\n${'─'.repeat(20)}\n`;
    day1.forEach(x => { msg += renderGroup(x) + "\n"; });
  }

  if (day2.length > 0) {
    msg += `\n⚪ 2天未說話—明日自動移除（${day2.length} 組）\n${'─'.repeat(20)}\n`;
    day2.forEach(x => { msg += renderGroup(x) + "\n"; });
  }

  msg += `${'═'.repeat(22)}\n共 ${totalGroups} 組 | ${totalTasks} 件待辦`;
  return msg;
}

// ─── LINE Push API（主動推播，不需要 replyToken） ──────────────
async function pushMessage(toUserId, messages) {
  try {
    const r = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: toUserId, messages },
      {
        headers: {
          Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );
    console.log("[Push] to:", toUserId, "status:", r.status);
  } catch (err) {
    console.error("[Push ERROR]", toUserId, err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ─── 每日定時回報（台灣時間 18:00 = UTC 10:00） ───────────────
function scheduleDailyReport() {
  function getNextTriggerMs() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(10, 0, 0, 0); // UTC 10:00 = 台灣 18:00
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function triggerReport() {
    const report = buildDailyReport();
    console.log("[DailyReport] 發送每日報告給", ADMIN_IDS.length, "位管理員");
    ADMIN_IDS.forEach(adminId => {
      pushMessage(adminId, [{ type: "text", text: report }]);
    });
    setTimeout(triggerReport, getNextTriggerMs());
  }

  const delay = getNextTriggerMs();
  const nextTime = new Date(Date.now() + delay);
  console.log(`[DailyReport] 下次發送：${nextTime.toISOString()}（${Math.round(delay/1000/60)} 分鐘後）`);
  setTimeout(triggerReport, delay);
}


// ─── 靜態資源 ─────────────────────────────────────────────────
app.use("/images", express.static(path.join(__dirname, "public/images")));

function img(f) {
  return BASE_URL + "/images/" + encodeURIComponent(f);
}

// ─── 商品目錄 ─────────────────────────────────────────────────
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
  "二樓": { label: "組合屋 2.1 二樓", description: "2.1m 樓高，靈活空間規劃\n適合臨時辦公室、工地宿舍\n📩 如需報價請洽詢", images: [img("二樓_01.jpg"), img("二樓_02.png"), img("二樓_03.jpg")] },
  "三樓": { label: "組合屋 2.1 三樓", description: "2.1m 樓高三層設計，最大化使用空間\n📩 如需報價請洽詢", images: [img("三樓_01.jpg"), img("三樓_02.jpg"), img("三樓_03.jpg")] },
  "展翼屋": { label: "10呎展翼屋", description: "創新展翼設計，快速展開即可使用\n含衛浴間、水槽\n📩 如需報價請洽詢", images: [img("展翼屋_01.jpg"), img("展翼屋_02.jpg"), img("展翼屋_03.jpg")] },
  "20呎展翼屋": { label: "20呎展翼屋", description: "加大版展翼設計，空間更寬敞\n含廚房、衛浴間、多功能空間\n📩 如需報價請洽詢", images: [img("展翼屋20_01.jpg"), img("展翼屋20_02.jpg"), img("展翼屋20_03.jpg")] },
  "折疊屋": { label: "折疊屋", description: "快速折疊展開，吊車即可定位安裝\n適合工地臨時辦公、農場宿舍\n📩 如需報價請洽詢", images: [img("折疊屋_01.jpg"), img("折疊屋_02.jpg"), img("折疊屋_03.jpg")] },
  "宿舍": { label: "組合屋宿舍", description: "大規模多人住宿首選\n可依需求客製間數與格局\n📩 如需報價請洽詢", images: [img("宿舍_01.jpg"), img("宿舍_02.jpg"), img("宿舍_03.jpg")] },
  "廚具": { label: "廚具", description: "組合屋專用廚具，多款風格可選\n含不鏽鋼檯面、水槽、抽油煙機\n📩 如需報價請洽詢", images: [img("廚具_01.jpg"), img("廚具_02.jpg"), img("廚具_03.jpg")] },
  "SPC地板": { label: "SPC地板", description: "石塑防水耐磨地板，組合屋首選\n色號：826暖灰、809薄荷、819冷灰\n📩 如需報價請洽詢", images: [img("SPC地板_01.jpg"), img("SPC地板_02.jpg"), img("SPC地板_03.jpg")] },
  "三合一門": { label: "三合一門", description: "氣密、隔熱、防盜三效合一\n鐵灰色鋁框，大片玻璃採光設計\n📩 如需報價請洽詢", images: [img("三合一門_01.jpg"), img("三合一門_02.jpg"), img("三合一門_01.jpg")] },
  "標準窗": { label: "標準窗", description: "組合屋標配推拉窗，鐵灰色款 / 白色款\n鋁框強化玻璃，附紗窗\n📩 如需報價請洽詢", images: [img("標準窗_01.png"), img("標準窗_02.jpg"), img("標準窗_02.jpg")] },
  "沙門": { label: "沙門（安全紗門）", description: "菱格鐵網安全紗門，通風防盜兼顧\n米白色鋁框，耐用抗鏽\n📩 如需報價請洽詢", images: [img("沙門_01.png"), img("沙門_01.png"), img("沙門_01.png")] },
  "DM": { label: "富林組合屋 產品DM", description: "富林組合屋\n雲林縣二崙鄉楊賢路143號\n\n單顆入門基礎款（1門2窗）\n3mx6m  NT$98,000\n4mx6m  NT$118,000\n4mx8m  NT$156,000\n\n衛浴加購\n大衛浴 NT$55,000\n小衛浴 NT$40,000\n\n廖先生 0929-010-882\nLine：@aa168", images: [img("DM_01.jpg"), img("DM_02.jpg"), img("DM_03.jpg")] },
};

// ─── Middleware ────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ─── LINE 簽名驗證 ─────────────────────────────────────────────
function verifyLineSignature(req, res, next) {
  const sig = req.headers["x-line-signature"];
  if (!sig) {
    console.log("[WARN] Missing x-line-signature");
    return res.status(401).send("Missing signature");
  }
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest("base64");
  if (hash !== sig) {
    console.log("[WARN] Invalid signature");
    return res.status(401).send("Invalid signature");
  }
  next();
}

// ─── 商品偵測 ──────────────────────────────────────────────────
function detectProduct(text) {
  for (const key of Object.keys(PRODUCTS)) {
    if (text.includes("@" + key)) return PRODUCTS[key];
  }
  return null;
}

// ─── Claude 翻譯 ───────────────────────────────────────────────
async function translateText(text) {
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `你是翻譯助理，根據輸入語言自動判斷並翻譯。

規則：
1. 訊息開頭若有 @人名、@英文名、@符號 等 LINE 提及標記，直接忽略，只翻譯後面的句子內容
2. 若 @提及 後面沒有任何實質內容，則完全不回應
3. 翻譯格式（緊湊，每行一個翻譯，只用國旗符號，不加其他文字）：
   - 輸入是中文 → 🇹🇭 [泰文翻譯]
                   🇺🇸 [英文翻譯]
   - 輸入是泰文 → 🇹🇼 [中文翻譯]
                   🇺🇸 [英文翻譯]
   - 輸入是英文 → 🇹🇼 [中文翻譯]
                   🇹🇭 [泰文翻譯]
4. 只輸出翻譯結果，不加任何解釋、說明或多餘空行`,
      messages: [{ role: "user", content: text }]
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      timeout: 30000
    }
  );
  return r.data.content[0].text;
}

// ─── LINE 回覆（支援 quoteToken 回覆視窗） ─────────────────────
async function replyMessages(replyToken, messages, quoteToken = null) {
  // quoteToken 只能加在 text 訊息上（不能加在 image/sticker）
  if (quoteToken && messages.length > 0) {
    const firstText = messages.find(m => m.type === "text");
    if (firstText) firstText.quoteToken = quoteToken;
  }
  const r = await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    {
      headers: {
        Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      timeout: 10000
    }
  );
  console.log("[LINE Reply] status:", r.status);
}

// ─── 取得來源 ID（群組/個人） ──────────────────────────────────
function getSourceId(event) {
  const src = event.source;
  if (src.type === "group") return src.groupId;
  if (src.type === "room") return src.roomId;
  return src.userId;
}

// ─── Webhook 主處理 ───────────────────────────────────────────
app.post("/webhook", verifyLineSignature, async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];
  console.log("[Webhook] events count:", events.length);

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    const quoteToken = event.message.quoteToken || null;
    const userId = event.source?.userId || "";
    const sourceId = getSourceId(event);
    const isAdmin = ADMIN_IDS.includes(userId);

    console.log("[Message]", text, "| userId:", userId, "| sourceId:", sourceId);

    // ── 白名單已停用，全部放行 ──

    // ── 每次有人說話，更新群組活躍時間，並確保群組已建立（自動抓名稱） ──
    await getOrCreateGroup(sourceId, event.source);
    touchGroup(sourceId);

    try {

      // ════════════════════════════════════════
      // 📋 @目錄
      // ════════════════════════════════════════
      if (["@目錄", "@选单", "@選單", "@menu", "@產品目錄"].includes(text)) {
        await replyMessages(replyToken, [{
          type: "text",
          text: `📋 富林組合屋 產品目錄\n（輸入 @品名 查詢詳情）\n\n🏠 框架顏色搭配：\n@黑框木紋　@黑框白板　@黑框灰黑\n@白框木紋　@白框白板　@白框灰黑\n\n🚿 衛浴系列：\n@大衛浴　@小衛浴　@水泥廁所\n@室外衛浴　@貼磁衛浴　@日式衛浴\n\n🏢 屋型系列：\n@二樓　@三樓　@展翼屋　@20呎展翼屋\n@折疊屋　@宿舍\n\n🛋 配件系列：\n@廚具　@SPC地板　@三合一門　@標準窗　@沙門\n\n📩 完整 DM 報價：\n@DM\n\n${'─'.repeat(18)}\n🌐 翻譯功能：\n直接傳任何文字即可自動翻譯\n中文 ↔ 泰文 ↔ 英文\n@關翻譯 關閉 ｜ @開翻譯 開啟`
        }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 📞 @聯絡
      // ════════════════════════════════════════
      if (["@聯絡", "@contact", "@联絡"].includes(text)) {
        await replyMessages(replyToken, [{
          type: "text",
          text: `📞 富林工程\n\n服務專線 0929-010-882\nLine：@aa168\n地址：臺南市成功里143號\n\n歡迎加入 Line 洽詢，提供1對1報價服務！`
        }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 🔑 @我的ID（方便取得 userId 加白名單）
      // ════════════════════════════════════════
      if (["@myid", "@我的id"].includes(text.toLowerCase())) {
        await replyMessages(replyToken, [{
          type: "text",
          text: `🔑 你的 LINE userId：\n${userId}\n\n📌 群組 ID：\n${sourceId}\n\n請傳給管理員，即可加入白名單 ✅`
        }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 👮 @加白名單（僅管理員）
      // 格式：@加白名單 U1234567890abcdef
      // ════════════════════════════════════════
      if (text.startsWith("@加白名單")) {
        if (!isAdmin) {
          await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken);
          continue;
        }
        const parts = text.split(/\s+/);
        const targetId = parts[1] || "";
        if (!targetId || !targetId.startsWith("U")) {
          await replyMessages(replyToken, [{
            type: "text",
            text: "⚠️ 格式錯誤\n\n請輸入：\n@加白名單 U1234567890abcdef\n\n（讓對方傳 @我的ID 取得）"
          }], quoteToken);
          continue;
        }
        allowedUsers.add(targetId);
        console.log("[Whitelist] 新增:", targetId, "| 目前白名單:", [...allowedUsers]);
        await replyMessages(replyToken, [{
          type: "text",
          text: `✅ 已新增白名單：\n${targetId}\n\n目前共 ${allowedUsers.size} 人\n\n⚠️ 注意：重啟後需重新設定，建議同步更新 Render 環境變數 ALLOWED_USER_IDS`
        }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 👮 @移除白名單（僅管理員）
      // 格式：@移除白名單 U1234567890abcdef
      // ════════════════════════════════════════
      if (text.startsWith("@移除白名單")) {
        if (!isAdmin) {
          await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken);
          continue;
        }
        const parts = text.split(/\s+/);
        const targetId = parts[1] || "";
        if (allowedUsers.has(targetId)) {
          allowedUsers.delete(targetId);
          await replyMessages(replyToken, [{ type: "text", text: `✅ 已移除：${targetId}\n目前共 ${allowedUsers.size} 人` }], quoteToken);
        } else {
          await replyMessages(replyToken, [{ type: "text", text: `⚠️ 找不到此 ID：${targetId}` }], quoteToken);
        }
        continue;
      }

      // ════════════════════════════════════════
      // 👮 @白名單列表（僅管理員）
      // ════════════════════════════════════════
      if (["@白名單列表", "@whitelist"].includes(text)) {
        if (!isAdmin) {
          await replyMessages(replyToken, [{ type: "text", text: "❌ 只有管理員可以使用此指令" }], quoteToken);
          continue;
        }
        const list = [...allowedUsers];
        const reply = list.length === 0
          ? "📋 白名單目前為空（全部放行）"
          : `📋 白名單（${list.length} 人）：\n\n${list.join("\n")}`;
        await replyMessages(replyToken, [{ type: "text", text: reply }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 🔄 @開翻譯 / @關翻譯
      // ════════════════════════════════════════
      if (["@開翻譯", "@启动翻译", "@翻譯開"].includes(text)) {
        translateEnabled.set(sourceId, true);
        await replyMessages(replyToken, [{
          type: "text",
          text: "✅ 翻譯功能已開啟\n\n直接傳任何文字即可自動翻譯 🌐"
        }], quoteToken);
        continue;
      }

      if (["@關翻譯", "@关闭翻译", "@翻譯關"].includes(text)) {
        translateEnabled.set(sourceId, false);
        await replyMessages(replyToken, [{
          type: "text",
          text: "🔇 翻譯功能已關閉\n\n傳 @開翻譯 重新啟動"
        }], quoteToken);
        continue;
      }

      // 翻譯狀態查詢
      if (["@翻譯狀態", "@翻译状态"].includes(text)) {
        const on = isTranslateOn(sourceId);
        await replyMessages(replyToken, [{
          type: "text",
          text: on
            ? "✅ 翻譯功能目前：開啟中\n\n傳 @關翻譯 可關閉"
            : "🔇 翻譯功能目前：關閉\n\n傳 @開翻譯 可開啟"
        }], quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 📝 記事系統（僅管理員，群組靜默，回覆到私訊）
      // ════════════════════════════════════════

      // @忽略記事（此群組不再自動記事）
      if (["@忽略記事", "@忽略"].includes(text)) {
        if (!isAdmin) continue;
        ignoredGroups.add(sourceId);
        const g = await getOrCreateGroup(sourceId, event.source);
        console.log("[Ignore] 新增忽略群組:", g.name);
        await pushMessage(userId, [{
          type: "text",
          text: `🚫 【${g.name}】已設為忽略\n此群組的訊息不再自動記事\n\n傳 @恢復記事 可重新啟用`
        }]);
        continue;
      }

      // @恢復記事
      if (["@恢復記事", "@恢復"].includes(text)) {
        if (!isAdmin) continue;
        ignoredGroups.delete(sourceId);
        const g = await getOrCreateGroup(sourceId, event.source);
        console.log("[Ignore] 移除忽略群組:", g.name);
        await pushMessage(userId, [{
          type: "text",
          text: `✅ 【${g.name}】已恢復自動記事`
        }]);
        continue;
      }

      // @忽略列表
      if (["@忽略列表"].includes(text)) {
        if (!isAdmin) continue;
        if (ignoredGroups.size === 0) {
          await pushMessage(userId, [{ type: "text", text: "📋 目前沒有設定忽略的群組" }]);
        } else {
          const names = [...ignoredGroups].map(id => {
            const g = groups.get(id);
            return g ? `• 【${g.name}】` : `• ${id.substring(0, 8)}...`;
          }).join("\n");
          await pushMessage(userId, [{ type: "text", text: `🚫 忽略記事的群組（${ignoredGroups.size} 組）：\n\n${names}` }]);
        }
        continue;
      }


      if (text.startsWith("@命名")) {
        if (!isAdmin) continue; // 非管理員靜默忽略
        const name = text.replace(/^@命名\s*/, "").trim();
        if (!name) {
          await pushMessage(userId, [{ type: "text", text: "⚠️ 格式：@命名 王先生報價群\n（可覆蓋自動取得的群組名稱）" }]);
          continue;
        }
        const g = await getOrCreateGroup(sourceId, event.source);
        g.name = name;
        await pushMessage(userId, [{ type: "text", text: `✅ 群組名稱已更新為：【${name}】` }]);
        continue;
      }

      // @記事 內容
      if (text.startsWith("@記事")) {
        if (!isAdmin) continue;
        const content = text.replace(/^@記事\s*/, "").trim();
        if (!content) {
          await pushMessage(userId, [{ type: "text", text: "⚠️ 請輸入記事內容\n格式：@記事 確認報價" }]);
          continue;
        }
        const g = await getOrCreateGroup(sourceId, event.source);
        const newTask = { id: taskIdCounter++, text: content, done: false, createdAt: new Date() };
        g.tasks.push(newTask);
        console.log("[Task] 新增:", newTask, "群組:", g.name);
        await pushMessage(userId, [{
          type: "text",
          text: `📝 已記錄 #${newTask.id}\n群組：【${g.name}】\n內容：「${content}」`
        }]);
        continue;
      }

      // @完成 編號
      if (text.startsWith("@完成")) {
        if (!isAdmin) continue;
        const num = parseInt(text.replace(/^@完成\s*/, "").trim());
        let found = null;
        for (const [, g] of groups) {
          const t = g.tasks.find(t => t.id === num);
          if (t) { found = t; break; }
        }
        if (!found) {
          await pushMessage(userId, [{ type: "text", text: `⚠️ 找不到 #${num}，傳 @事項 確認編號` }]);
          continue;
        }
        if (found.done) {
          await pushMessage(userId, [{ type: "text", text: `ℹ️ #${num} 已經是完成狀態` }]);
          continue;
        }
        found.done = true;
        found.doneAt = new Date();
        await pushMessage(userId, [{ type: "text", text: `✅ #${num} 已完成\n「${found.text}」` }]);
        continue;
      }

      // @刪除 編號
      if (text.startsWith("@刪除")) {
        if (!isAdmin) continue;
        const num = parseInt(text.replace(/^@刪除\s*/, "").trim());
        let removed = null;
        for (const [, g] of groups) {
          const idx = g.tasks.findIndex(t => t.id === num);
          if (idx !== -1) { removed = g.tasks.splice(idx, 1)[0]; break; }
        }
        if (!removed) {
          await pushMessage(userId, [{ type: "text", text: `⚠️ 找不到 #${num}` }]);
          continue;
        }
        await pushMessage(userId, [{ type: "text", text: `🗑 #${num} 已刪除\n「${removed.text}」` }]);
        continue;
      }

      // @事項（查看此群組的事項）
      if (["@事項", "@記事列表"].includes(text)) {
        if (!isAdmin) continue;
        await pushMessage(userId, [{ type: "text", text: getGroupTasksText(sourceId) }]);
        continue;
      }

      // @今日報告（立即觸發）
      if (["@今日報告", "@報告"].includes(text)) {
        if (!isAdmin) continue;
        const report = buildDailyReport();
        await pushMessage(userId, [{ type: "text", text: report }]);
        continue;
      }

      // @清除已完成
      if (text === "@清除已完成") {
        if (!isAdmin) continue;
        let cleared = 0;
        for (const [, g] of groups) {
          const before = g.tasks.length;
          g.tasks = g.tasks.filter(t => !t.done);
          cleared += before - g.tasks.length;
        }
        await pushMessage(userId, [{
          type: "text",
          text: `🧹 已清除所有群組中 ${cleared} 筆已完成記事`
        }]);
        continue;
      }


      const product = detectProduct(text);
      if (product) {
        const imageMsgs = product.images
          .filter(u => u && u.startsWith("http"))
          .map(u => ({ type: "image", originalContentUrl: u, previewImageUrl: u }));
        const msgs = [
          ...imageMsgs,
          { type: "text", text: product.label + "\n\n" + product.description }
        ];
        await replyMessages(replyToken, msgs, quoteToken);
        continue;
      }

      // ════════════════════════════════════════
      // 🔔 關鍵字自動記事（靜默推播給管理員）
      // ════════════════════════════════════════
      const AUTO_KEYWORDS = [
        // 中文
        "報價", "訂購", "預約", "確認", "合約", "付款", "匯款",
        "多少錢", "什麼時候", "可以嗎", "麻煩", "簽約", "要訂",
        "幫我", "能不能", "何時", "幾號", "幾點", "需要",
        // 泰文
        "ราคา", "สั่ง", "นัด", "ยืนยัน", "เท่าไร", "จ่าย",
        "สัญญา", "เมื่อไร", "ได้ไหม", "ช่วย", "ต้องการ", "อยาก"
      ];

      const hitKeyword = AUTO_KEYWORDS.find(kw => text.includes(kw));
      if (hitKeyword && ADMIN_IDS.length > 0 && !isAdmin && !ignoredGroups.has(sourceId)) {
        // 自動建立記事
        const g = await getOrCreateGroup(sourceId, event.source);
        const newTask = {
          id: taskIdCounter++,
          text: text.substring(0, 80), // 最多 80 字
          done: false,
          createdAt: new Date(),
          auto: true
        };
        g.tasks.push(newTask);

        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        console.log("[AutoTask] 關鍵字:", hitKeyword, "| 群組:", g.name, "| 記事:", newTask.text);

        // 靜默推播給所有管理員
        ADMIN_IDS.forEach(adminId => {
          pushMessage(adminId, [{
            type: "text",
            text: `🔔 自動記事 #${newTask.id}\n群組：【${g.name}】\n關鍵字：${hitKeyword}\n內容：${newTask.text}\n時間：${timeStr}\n\n傳 @完成 ${newTask.id} 標記完成`
          }]);
        });
        // 不 continue，讓翻譯照常執行（如果有開的話）
      }

      // ════════════════════════════════════════
      // 🌐 翻譯（需開啟且不是 @ 指令）
      // ════════════════════════════════════════
      // @ 開頭但不是已知指令 → 視為一般訊息，繼續翻譯
      // （如 @王先生、@all 等 LINE 提及，直接翻譯即可）

      if (!isTranslateOn(sourceId)) {
        continue;
      }

      // 剝掉開頭的 @提及（@人名、@all 等），只翻譯後面的內容
      const stripped = text.replace(/^@\S+\s*/, "").trim();
      if (!stripped) continue; // @提及後面沒有內容，跳過

      console.log("[Translate] input:", stripped.substring(0, 50));
      const translated = await translateText(stripped);
      console.log("[Translate] output:", translated.substring(0, 50));
      await replyMessages(replyToken, [{ type: "text", text: translated }], quoteToken);

    } catch (err) {
      console.error("[ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
});

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "fulin-line-bot",
    products: Object.keys(PRODUCTS).length,
    token_prefix: LINE_CHANNEL_ACCESS_TOKEN ? LINE_CHANNEL_ACCESS_TOKEN.substring(0, 10) + "..." : "MISSING",
    base_url: BASE_URL || "MISSING",
    translate_enabled_count: translateEnabled.size,
    whitelist_count: allowedUsers.size
  });
});

app.listen(PORT, () => {
  console.log("✅ 富林 LINE 機器人啟動，Port:", PORT);
  console.log("BASE_URL:", BASE_URL);
  console.log("TOKEN prefix:", LINE_CHANNEL_ACCESS_TOKEN ? LINE_CHANNEL_ACCESS_TOKEN.substring(0, 10) : "MISSING");
  console.log("ADMIN_IDS:", ADMIN_IDS.length > 0 ? ADMIN_IDS : "未設定（建議設定）");
  console.log("Whitelist:", allowedUsers.size > 0 ? [...allowedUsers] : "空（全部放行）");

  // 啟動每日定時回報
  if (ADMIN_IDS.length > 0) {
    scheduleDailyReport();
  } else {
    console.log("[DailyReport] ⚠️ ADMIN_IDS 未設定，每日回報不會啟動");
  }
});
