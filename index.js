
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
// userId 白名單（逗號分隔，空白=全部放行）
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(id => id.trim()).filter(Boolean)
  : [];

function isAllowedUser(event) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  const userId = event.source?.userId;
  if (!userId) return false;
  const ok = ALLOWED_USER_IDS.includes(userId);
  if (!ok) console.log('[BLOCKED] userId=' + userId);
  return ok;
}
app.use("/images", express.static(path.join(__dirname, "public/images")));

function img(f) {
  return BASE_URL + "/images/" + encodeURIComponent(f);
}

const PRODUCTS = {
  "黑框木紋": { label: "黑框木紋 ★熱門★", description: "黑色鐵框搭配木紋面板，工業風與自然感完美融合\n尺寸：多規格可選\n\n▶️ 影片：https://youtu.be/Xqw4Utll1yk\n📩 如需報價請洽詢", images: ["https://img.youtube.com/vi/Xqw4Utll1yk/maxresdefault.jpg", img("黑框木紋_02.png"), img("黑框木紋_03.jpg")] },
  "白框木紋": { label: "白框木紋", description: "清爽白框搭配木紋面板，現代簡約風格\n📩 ", images: [img("白框木紋_01.jpg"), img("白框木紋_02.jpg"), img("白框木紋_03.jpg")] },
  "白框白板": { label: "白框白板", description: "全白簡潔設計，適合醫療、辦公空間\n📩 ", images: [img("白框白板_01.jpg"), img("白框白板_02.jpg"), img("白框白板_03.jpg")] },
  "白框灰黑": { label: "白框灰黑", description: "白框搭配灰黑面板，時尚對比設計\n📩 ", images: [img("白框灰黑_01.jpg"), img("白框灰黑_02.jpg"), img("白框灰黑_03.jpg")] },
  "黑框白板": { label: "黑框白板", description: "黑框白面，俐落高對比設計\n📩 ", images: [img("黑框白板_01.jpg"), img("黑框白板_02.jpg"), img("黑框白板_03.jpg")] },
  "黑框灰黑": { label: "黑框灰黑", description: "全黑深色調，沉穩低調的進階選擇\n📩 ", images: [img("黑框灰黑_01.jpg"), img("黑框灰黑_02.jpg"), img("黑框灰黑_03.jpg")] },
  "大衛浴": { label: "大衛浴 120x190x220", description: "尺寸：120x190x220 cm\n寬敞舒適，適合主臥衛浴規劃\n📩 ", images: [img("大衛浴_01.png"), img("大衛浴_02.jpg"), img("大衛浴_03.jpg")] },
  "小衛浴": { label: "小衛浴 110x140x220", description: "尺寸：110x140x220 cm\n緊湊高效，適合次臥或公共衛浴\n📩 ", images: [img("小衛浴_01.jpg"), img("小衛浴_02.jpg"), img("小衛浴_03.png")] },
  "水泥廁所": { label: "水泥廁所", description: "清水模質感，工業Loft風格\n耐用低維護，適合商業空間\n📩 ", images: [img("水泥廁所_01.jpg"), img("水泥廁所_02.jpg"), img("水泥廁所_03.jpg")] },
  "室外衛浴": { label: "室外衛浴", description: "防水耐候設計，適合戶外、露營區、工地\n📩 ", images: [img("室外衛浴_01.jpg"), img("室外衛浴_02.jpg"), img("室外衛浴_03.jpg")] },
  "貼磁衛浴": { label: "貼磁衛浴 1.7x2.3x2", description: "磁磚貼面，質感精緻，適合住宅與飯店\n📩 ", images: [img("貼磁衛浴_01.jpg"), img("貼磁衛浴_02.jpg"), img("貼磁衛浴_03.jpg")] },
  "日式衛浴": { label: "日式衛浴", description: "石紋壁板、黑框玻璃、頂噴花灑，質感飯店級\n含馬桶、洗手台、淋浴間\n📩 ", images: [img("日式衛浴_01.jpg"), img("日式衛浴_03.jpg"), img("日式衛浴_04.jpg")] },
  "二樓": { label: "組合屋 2.1 二樓", description: "2.1m 樓高，靈活空間規劃\n適合臨時辦公室、工地宿舍\n📩 ", images: [img("二樓_01.jpg"), img("二樓_02.png"), img("二樓_03.jpg")] },
  "三樓": { label: "組合屋 2.1 三樓", description: "2.1m 樓高三層設計，最大化使用空間\n📩 ", images: [img("三樓_01.jpg"), img("三樓_02.jpg"), img("三樓_03.jpg")] },
  "展翼屋": { label: "10呎展翼屋", description: "創新展翼設計，快速展開即可使用\n含衛浴間、水槽\n📩 ", images: [img("展翼屋_01.jpg"), img("展翼屋_02.jpg"), img("展翼屋_03.jpg")] },
  "20呎展翼屋": { label: "20呎展翼屋", description: "加大版展翼設計，空間更寬敞\n含廚房、衛浴間、多功能空間\n📩 ", images: [img("展翼屋20_01.jpg"), img("展翼屋20_02.jpg"), img("展翼屋20_03.jpg")] },
  "折疊屋": { label: "折疊屋", description: "快速折疊展開，吊車即可定位安裝\n適合工地臨時辦公、農場宿舍\n📩 ", images: [img("折疊屋_01.jpg"), img("折疊屋_02.jpg"), img("折疊屋_03.jpg")] },
  "宿舍": { label: "組合屋宿舍", description: "大規模多人住宿首選\n可依需求客製間數與格局\n📩 ", images: [img("宿舍_01.jpg"), img("宿舍_02.jpg"), img("宿舍_03.jpg")] },
  "廚具": { label: "廚具", description: "組合屋專用廚具，多款風格可選\n含不鏽鋼檯面、水槽、抽油煙機\n📩 ", images: [img("廚具_01.jpg"), img("廚具_02.jpg"), img("廚具_03.jpg")] },
  "SPC地板": { label: "SPC地板", description: "石塑防水耐磨地板，組合屋首選\n色號：826暖灰、809薄荷、819冷灰\n📩 ", images: [img("SPC地板_01.jpg"), img("SPC地板_02.jpg"), img("SPC地板_03.jpg")] },
  "三合一門": { label: "三合一門", description: "氣密、隔熱、防盜三效合一\n鐵灰色鋁框，大片玻璃採光設計\n📩 ", images: [img("三合一門_01.jpg"), img("三合一門_02.jpg"), img("三合一門_01.jpg")] },
  "標準窗": { label: "標準窗", description: "組合屋標配推拉窗，鐵灰色款 / 白色款\n鋁框強化玻璃，附紗窗\n📩 ", images: [img("標準窗_01.png"), img("標準窗_02.jpg"), img("標準窗_02.jpg")] },
  "沙門": { label: "沙門（安全紗門）", description: "菱格鐵網安全紗門，通風防盜兼顧\n米白色鋁框，耐用抗鏽\n📩 ", images: [img("沙門_01.png"), img("沙門_01.png"), img("沙門_01.png")] },
  "DM": { label: "富林組合屋 產品DM", description: "富林組合屋\n雲林縣二崙鄉楊賢路143號\n\n單顆入門基礎款（1門2窗）\n3mx6m  NT$98,000\n4mx6m  NT$118,000\n4mx8m  NT$156,000\n\n衛浴加購\n大衛浴 NT$55,000\n小衛浴 NT$40,000\n\n廖先生 0929-010-882\nLine：@aa168", images: [img("DM_01.jpg"), img("DM_02.jpg"), img("DM_03.jpg")] },
};

// Middleware
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Signature verification
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

// Find product by @keyword
function detectProduct(text) {
  for (const key of Object.keys(PRODUCTS)) {
    if (text.includes("@" + key)) return PRODUCTS[key];
  }
  return null;
}

// Claude translation
async function translateText(text) {
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "翻譯機器人。\n輸入中文（繁/簡）→ 翻成泰文+英文，格式：\n🇹🇭 Thai：[譯文]\n🇺🇸 English：[譯文]\n\n輸入泰文 → 翻成英文+中文，格式：\n🇺🇸 English：[譯文]\n🇹🇼 中文：[譯文]\n\n其他語言 → 翻成中文+英文，格式：\n🇹🇼 中文：[譯文]\n🇺🇸 English：[譯文]\n\n保持原文語氣，只輸出翻譯結果。",
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

// Reply to LINE
async function replyMessages(replyToken, messages) {
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

// Webhook handler
app.post("/webhook", verifyLineSignature, async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];
  console.log("[Webhook] events count:", events.length);

  for (const event of events) {
    if (!isAllowedUser(event)) continue;
```
    if (event.type !== "message" || event.message.type !== "text") continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    console.log("[Message]", text);

    try {
      // @目錄
      if (["@目錄", "@型錄", "@產品", "@品項", "@所有產品"].includes(text)) {
        await replyMessages(replyToken, [{
          type: "text",
          text: "📋 富林組合屋 產品目錄\n（輸入 @品名 查看照片）\n\n💰 輸入「@DM」查看價格型錄\n\n🏠 框架搭配：\n@白框木紋　@白框白板　@白框灰黑\n@黑框木紋　@黑框白板　@黑框灰黑\n\n🚿 衛浴系列：\n@大衛浴　@小衛浴　@水泥廁所\n@室外衛浴　@貼磁衛浴　@日式衛浴\n\n🏠 組合屋系列：\n@二樓　@三樓　@展翼屋　@20呎展翼屋　@折疊屋　@宿舍\n\n🍳 配備系列：\n@廚具　@SPC地板　@三合一門　@標準窗　@沙門\n\n範例：輸入「@黑框木紋」查看照片"
        }]);
        continue;
      }

      // @匯款
      if (["@匯款", "@帳號", "@轉帳", "@付款"].includes(text)) {
        await replyMessages(replyToken, [{
          type: "text",
          text: "💳 富林組合屋 匯款資訊\n\n銀行：華南銀行 西螺分行\n總行代號：008\n帳號：542-20-020369-5\n戶名：廖國賓\n\n匯款後請傳截圖給我們確認，謝謝！"
        }]);
        continue;
      }

      // @聯絡
      if (["@聯絡", "@電話", "@contact"].includes(text)) {
        await replyMessages(replyToken, [{
          type: "text",
          text: "📞 富林組合屋\n\n廖先生 0929-010-882\nLine：@aa168\n地址：雲林縣二崙鄉楊賢路143號\n\n歡迎來電或加Line詢問報價！"
        }]);
        continue;
      }

      // @品名 查詢
      const product = detectProduct(text);
      if (product) {
        // 只傳有效圖片（過濾掉可能失敗的）
        const imageMessages = product.images
          .filter(u => u && u.startsWith("http"))
          .map(u => ({
            type: "image",
            originalContentUrl: u,
            previewImageUrl: u
          }));

        const msgs = [
          ...imageMessages,
          { type: "text", text: product.label + "\n\n" + product.description }
        ];
        await replyMessages(replyToken, msgs);
        continue;
      }

      // 翻譯
      console.log("[Translate] input:", text.substring(0, 50));
      const translated = await translateText(text);
      console.log("[Translate] output:", translated.substring(0, 50));
      await replyMessages(replyToken, [{ type: "text", text: translated }]);

    } catch (err) {
      console.error("[ERROR]", err.response ? JSON.stringify(err.response.data) : err.message);
      // 不要再次呼叫 replyMessages，避免二次失敗
    }
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "fulin-line-bot",
    products: Object.keys(PRODUCTS).length,
    token_prefix: LINE_CHANNEL_ACCESS_TOKEN ? LINE_CHANNEL_ACCESS_TOKEN.substring(0, 10) + "..." : "MISSING",
    base_url: BASE_URL || "MISSING"
  });
});

app.listen(PORT, () => {
  console.log("✅ 富林 LINE 機器人啟動，Port:", PORT);
  console.log("BASE_URL:", BASE_URL);
  console.log("TOKEN prefix:", LINE_CHANNEL_ACCESS_TOKEN ? LINE_CHANNEL_ACCESS_TOKEN.substring(0, 10) : "MISSING");
});
