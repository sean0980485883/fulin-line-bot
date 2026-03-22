const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.BASE_URL; // 例如 https://line-bot-xxxx.onrender.com
const PORT = process.env.PORT || 3000;

// ============================================================
//  靜態圖片托管（圖片放在 public/images/ 資料夾）
// ============================================================
app.use("/images", express.static(path.join(__dirname, "public/images")));

// ============================================================
//  商品目錄
//  圖片路徑：public/images/檔名
//  URL 會自動變成：https://你的網址/images/檔名
// ============================================================
function img(filename) {
  return `${BASE_URL}/images/${encodeURIComponent(filename)}`;
}

const PRODUCTS = {
  "黑框木紋": {
    label: "黑框木紋 ★熱門★",
    description: "黑框木紋系列｜★ 熱銷首選 ★\n黑色鐵框搭配木紋面板，工業風與自然感完美融合\n尺寸：多規格可選\n\n▶️ 影片介紹：https://youtu.be/Xqw4Utll1yk\n📩 如需報價請洽詢",
    images: [
      "https://img.youtube.com/vi/Xqw4Utll1yk/maxresdefault.jpg",
      img("黑框木紋_02.png"),
      img("黑框木紋_03.jpg"),
    ],
  },
  "白框木紋": {
    label: "白框木紋",
    description: "白框木紋系列｜清爽白框搭配木紋面板，現代簡約風格\n尺寸：多規格可選｜📩 如需報價請洽詢",
    images: [
      img("白框木紋_01.jpg"),   // ← 之後上傳照片後自動生效
      img("白框木紋_02.jpg"),
      img("白框木紋_03.jpg"),
    ],
  },
  "白框白板": {
    label: "白框白板",
    description: "白框白板系列｜全白簡潔設計，適合醫療、辦公空間\n尺寸：多規格可選｜📩 如需報價請洽詢",
    images: [
      img("白框白板_01.jpg"),
      img("白框白板_02.jpg"),
      img("白框白板_03.jpg"),
    ],
  },
  "白框灰黑": {
    label: "白框灰黑",
    description: "白框灰黑系列｜白框搭配灰黑面板，時尚對比設計\n尺寸：多規格可選｜📩 如需報價請洽詢",
    images: [
      img("白框灰黑_01.jpg"),
      img("白框灰黑_02.jpg"),
      img("白框灰黑_03.jpg"),
    ],
  },
  "黑框白板": {
    label: "黑框白板",
    description: "黑框白板系列｜黑框白面，俐落高對比設計\n尺寸：多規格可選｜📩 如需報價請洽詢",
    images: [
      img("黑框白板_01.jpg"),
      img("黑框白板_02.jpg"),
      img("黑框白板_03.jpg"),
    ],
  },
  "黑框灰黑": {
    label: "黑框灰黑",
    description: "黑框灰黑系列｜全黑深色調，沉穩低調的進階選擇\n尺寸：多規格可選｜📩 如需報價請洽詢",
    images: [
      img("黑框灰黑_01.jpg"),
      img("黑框灰黑_02.jpg"),
      img("黑框灰黑_03.jpg"),
    ],
  },
  "大衛浴": {
    label: "大衛浴 120×190×220",
    description: "大衛浴系列｜尺寸：120×190×220 cm\n寬敞舒適，適合主臥衛浴規劃\n📩 如需報價請洽詢",
    images: [
      img("大衛浴_01.png"),
      img("大衛浴_02.jpg"),
      img("大衛浴_03.jpg"),
    ],
  },
  "小衛浴": {
    label: "小衛浴 110×140×220",
    description: "小衛浴系列｜尺寸：110×140×220 cm\n緊湊高效，適合次臥或公共衛浴\n📩 如需報價請洽詢",
    images: [
      img("小衛浴_01.jpg"),
      img("小衛浴_02.jpg"),
      img("小衛浴_03.png"),
    ],
  },
  "水泥廁所": {
    label: "水泥廁所",
    description: "水泥廁所系列｜清水模質感，工業Loft風格\n耐用低維護，適合商業空間與公共廁所\n📩 如需報價請洽詢",
    images: [
      img("水泥廁所_01.jpg"),
      img("水泥廁所_02.jpg"),
      img("水泥廁所_03.jpg"),
    ],
  },
  "室外衛浴": {
    label: "室外衛浴",
    description: "室外衛浴系列｜防水耐候設計，適合戶外、露營區、工地\n📩 如需報價請洽詢",
    images: [
      img("室外衛浴_01.jpg"),
      img("室外衛浴_02.jpg"),
      img("室外衛浴_03.jpg"),
    ],
  },
  "貼磁衛浴": {
    label: "貼磁衛浴 1.7×2.3×2",
    description: "貼磁衛浴系列｜尺寸：1.7×2.3×2 m\n磁磚貼面，質感精緻，適合住宅與飯店\n📩 如需報價請洽詢",
    images: [
      img("貼磁衛浴_01.jpg"),
      img("貼磁衛浴_02.jpg"),
      img("貼磁衛浴_03.jpg"),
    ],
  },
  "二樓": {
    label: "組合屋 2.1 二樓",
    description: "組合屋二樓系列｜2.1m 樓高，靈活空間規劃\n適合臨時辦公室、工地宿舍、臨時住所\n📩 如需報價請洽詢",
    images: [
      img("二樓_01.jpg"),
      img("二樓_02.png"),
      img("二樓_03.jpg"),
    ],
  },
  "廚具": {
    label: "廚具",
    description: "廚具系列｜組合屋專用廚具，多款風格可選\n木紋款、白色款、灰色款一應俱全\n含不鏽鋼檯面、水槽、抽油煙機\n尺寸：依空間客製｜📩 如需報價請洽詢",
    images: [
      img("廚具_01.jpg"),
      img("廚具_02.jpg"),
      img("廚具_03.jpg"),
    ],
  },
  "展翼屋": {
    label: "10呎展翼屋",
    description: "10呎展翼屋｜創新展翼設計，快速展開即可使用\n外觀：黑框灰色紋路面板，現代時尚\n內裝：灰色系內牆 + 木地板 + LED燈\n含衛浴間（淋浴、馬桶）、水槽\n尺寸：約 10 呎｜📩 如需報價請洽詢",
    images: [
      img("展翼屋_01.jpg"),
      img("展翼屋_02.jpg"),
      img("展翼屋_03.jpg"),
    ],
  },
  "20呎展翼屋": {
    label: "20呎展翼屋",
    description: "20呎展翼屋｜加大版展翼設計，空間更寬敞\n外觀：黑框深色面板，附大型遮陽棚架與木平台\n內裝：全白系內牆、木地板、LED燈\n含廚房（L型廚具+水槽）、衛浴間、多功能空間\n尺寸：約 20 呎｜📩 如需報價請洽詢",
    images: [
      img("展翼屋20_01.jpg"),
      img("展翼屋20_02.jpg"),
      img("展翼屋20_03.jpg"),
    ],
  },
  "折疊屋": {
    label: "折疊屋",
    description: "折疊屋｜快速折疊展開，吊車即可定位安裝\n白框灰白面板，輕巧耐用\n適合工地臨時辦公、農場宿舍、緊急住所\n可快速移位，機動性極高\n📩 如需報價請洽詢",
    images: [
      img("折疊屋_01.jpg"),
      img("折疊屋_02.jpg"),
      img("折疊屋_03.jpg"),
    ],
  },
  "宿舍": {
    label: "組合屋宿舍",
    description: "組合屋宿舍系列｜大規模多人住宿首選\n單層多間隔間排列，或雙層樓宿舍設計\n黑框木紋外觀，耐用美觀\n適合工廠員工宿舍、工地營區、外勞宿舍\n可依需求客製間數與格局\n📩 如需報價請洽詢",
    images: [
      img("宿舍_01.jpg"),
      img("宿舍_02.jpg"),
      img("宿舍_03.jpg"),
    ],
  },
  "SPC地板": {
    label: "SPC地板",
    description: "SPC地板｜石塑防水耐磨地板，組合屋首選\n色號選擇：826（暖灰）、809（薄荷）、819（冷灰）\n防水、耐刮、好清潔，腳感舒適\n適合組合屋、室內裝修全場域鋪設\n📩 如需報價或色樣請洽詢",
    images: [
      img("SPC地板_01.jpg"),
      img("SPC地板_02.jpg"),
      img("SPC地板_03.jpg"),
    ],
  },
  "三合一門": {
    label: "三合一門",
    description: "三合一門｜氣密、隔熱、防盜三效合一\n鐵灰色鋁框，大片玻璃採光設計\n適合組合屋主入口，質感升級首選\n含上亮窗設計，通風採光俱佳\n📩 如需報價請洽詢",
    images: [
      img("三合一門_01.jpg"),
      img("三合一門_02.jpg"),
      img("三合一門_01.jpg"),
    ],
  },
  "標準窗": {
    label: "標準窗",
    description: "標準窗｜組合屋標配推拉窗，兩色可選\n▪ 鐵灰色款：低調現代感，搭配黑框系列\n▪ 白色款：清爽簡潔，搭配白框系列\n鋁框強化玻璃，附紗窗設計\n📩 如需報價請洽詢",
    images: [
      img("標準窗_01.png"),
      img("標準窗_02.jpg"),
      img("標準窗_02.jpg"),
    ],
  },
  "沙門": {
    label: "沙門（安全紗門）",
    description: "沙門｜菱格鐵網安全紗門，通風防盜兼顧\n米白色鋁框，耐用抗鏽\n適合組合屋前後門加裝，夏天通風神器\n📩 如需報價請洽詢",
    images: [
      img("沙門_01.png"),
      img("沙門_01.png"),
      img("沙門_01.png"),
    ],
  },
  "玻璃門": {
    label: "玻璃門／落地窗",
    description: "玻璃門系列｜多款規格可選\n▪ 推拉式玻璃門：188×247.5cm，黑框鐵灰玻璃\n▪ 四開玻璃門：283×247cm，大開口設計\n▪ 微綠玻璃氣密窗：落地全玻璃，極致採光\n適合展示空間、客廳主牆、開放式設計\n📩 如需報價請洽詢",
    images: [
      img("玻璃門_01.jpg"),
      img("玻璃門_02.jpg"),
      img("玻璃門_03.jpg"),
    ],
  },
  "日式衛浴": {
    label: "日式衛浴",
    description: "日式衛浴｜精緻輕奢風格，整體式設計\n石紋壁板、黑框玻璃、頂噴花灑，質感飯店級\n款式：石紋款（灰色）、白色款可選\n含馬桶、洗手台、淋浴間\n尺寸：依需求客製｜📩 如需報價請洽詢",
    images: [
      img("日式衛浴_01.jpg"),
      img("日式衛浴_03.jpg"),
      img("日式衛浴_04.jpg"),
    ],
  },
  "DM": {
    label: "富林組合屋 產品型錄",
    description: "🏠 富林組合屋｜雲林縣二崙鄉楊賢路143號\n📞 0929-010882 廖先生\n💬 Line：@aa168\n\n📋 基礎款單顆報價（1門2窗）\n▪ 3m×6m → NT$98,000\n▪ 4m×6m → NT$118,000\n▪ 4m×8m → NT$156,000\n\n🚿 衛浴加購\n▪ 大衛浴 120×190×220 → NT$55,000\n▪ 小衛浴 110×140×220 → NT$40,000\n\n底版顏色：黑、白、木紋\n框架顏色：黑、白\n\n📩 其他規格歡迎詢價",
    images: [
      img("DM_02.jpg"),
      img("DM_02.jpg"),
      img("DM_02.jpg"),
    ],
  },
  "DM": {
    label: "富林組合屋 產品DM",
    description: "🏠 富林組合屋\n雲林縣二崙鄉楊賢路143號\n\n📋 單顆入門基礎款（1門2窗）\n▪ 3m×6m　NT$98,000\n▪ 4m×6m　NT$118,000\n▪ 4m×8m　NT$156,000\n\n底版顏色：黑、白、木紋\n框架顏色：黑、白\n\n📞 廖先生 0929-010-882\nLine：@aa168",
    images: [
      img("DM_01.jpg"),
      img("DM_02.jpg"),
      img("DM_03.jpg"),
    ],
  },
  "三樓": {
    label: "組合屋 2.1 三樓",
    description: "組合屋三樓系列｜2.1m 樓高三層設計，最大化使用空間\n適合工地宿舍、臨時建物、多人住宿\n📩 如需報價請洽詢",
    images: [
      img("三樓_01.jpg"),
      img("三樓_02.jpg"),
      img("三樓_03.jpg"),
    ],
  },
};

// ============================================================
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

function verifyLineSignature(req, res, next) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return res.status(401).send("Missing signature");
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest("base64");
  if (hash !== signature) return res.status(401).send("Invalid signature");
  next();
}

function detectProduct(text) {
  for (const key of Object.keys(PRODUCTS)) {
    if (text.includes(`@${key}`)) return PRODUCTS[key];
  }
  return null;
}

async function translateText(text) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `你是一個專業的多語言翻譯機器人，部署在 LINE 群組中。

目標語言規則：
- 輸入中文（繁體或簡體）→ 同時翻譯成泰文與英文
- 輸入泰文 → 同時翻譯成英文與繁體中文
- 其他語言 → 同時翻譯成繁體中文與英文

輸出格式（不要多餘說明）：

若輸入中文：
🇹🇭 Thai：[泰文翻譯]
🇺🇸 English：[英文翻譯]

若輸入泰文：
🇺🇸 English：[英文翻譯]
🇹🇼 中文：[繁體中文翻譯]

若輸入其他語言：
🇹🇼 中文：[繁體中文翻譯]
🇺🇸 English：[英文翻譯]

保持原文的語氣、標點與換行格式。`,
      messages: [{ role: "user", content: text }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );
  return response.data.content[0].text;
}

async function replyMessages(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

app.post("/webhook", verifyLineSignature, async (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    if (!text) continue;

    // @聯絡
    if (["@聯絡", "@電話", "@contact"].includes(text)) {
      await replyMessages(replyToken, [{
        type: "text",
        text: "📞 富林組合屋\n\n廖先生 0929-010-882\nLine：@aa168\n地址：雲林縣二崙鄉楊賢路143號\n\n歡迎來電或加Line詢問報價！",
      }]);
      continue;
    }

    // @目錄
    if (["@目錄", "@型錄", "@產品", "@品項", "@所有產品", "@DM", "@價格", "@聯絡"].includes(text)) {
      await replyMessages(replyToken, [{
        type: "text",
        text: `📋 富林組合屋 產品目錄\n（輸入 @品名 查看照片）\n\n🏠 組合屋 框架搭配：\n@白框木紋　@白框白板　@白框灰黑\n@黑框木紋　@黑框白板　@黑框灰黑\n\n🚿 衛浴系列：\n@大衛浴　@小衛浴　@水泥廁所\n@室外衛浴　@貼磁衛浴　@日式衛浴\n\n🏠 組合屋系列：\n@二樓　@三樓　@展翼屋　@20呎展翼屋　@折疊屋　@宿舍\n\n💰 輸入「@DM」查看價格型錄

範例：輸入「@黑框木紋」查看照片`,
      }]);
      continue;
    }

    // @匯款 帳號資訊
    if (["@匯款", "@帳號", "@轉帳", "@付款"].includes(text)) {
      await replyMessages(replyToken, [{
        type: "text",
        text: "💳 富林組合屋 匯款資訊\n\n銀行：華南銀行 西螺分行\n總行代號：008\n帳號：542-20-020369-5\n戶名：廖國賓\n\n匯款後請傳截圖給我們確認，謝謝！",
      }]);
      continue;
    }

    // @品名 查詢
    const product = detectProduct(text);
    if (product) {
      const imageMessages = product.images.map((url) => ({
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url,
      }));
      await replyMessages(replyToken, [
        ...imageMessages,
        { type: "text", text: `🪵 ${product.label}\n\n${product.description}` },
      ]);
      continue;
    }

    // 一般訊息 → 翻譯
    try {
      const translated = await translateText(text);
      await replyMessages(replyToken, [{ type: "text", text: translated }]);
    } catch (err) {
      console.error("[錯誤]", err.message);
      await replyMessages(replyToken, [{ type: "text", text: "⚠️ 處理失敗，請稍後再試。" }]);
    }
  }
});

app.get("/", (req, res) => {
  res.json({ status: "🟢 運行中", service: "富林 LINE 機器人", products: Object.keys(PRODUCTS).length });
});

app.listen(PORT, () => {
  console.log(`✅ 富林 LINE 機器人啟動，Port: ${PORT}`);
});
