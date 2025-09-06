import express from "express";
import pino from "pino";
import dotenv from "dotenv";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QR from "qrcode"; // <-- untuk render QR ke SVG di /qr

dotenv.config();

const logger = pino({ level: "info" });
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./auth";

let sock;
let isReady = false; // koneksi WA OPEN?
let lastQR = ""; // simpan QR terakhir untuk /qr

// ===== Helper: ekstrak teks dari berbagai tipe pesan =====
function extractText(msg) {
  const m = msg?.message;
  if (!m) return "";

  // unwrap common wrappers
  const unwrap = (x) => x?.message || x;
  const m1 = unwrap(m.ephemeralMessage) || unwrap(m.viewOnceMessageV2) || m;

  // text/plain
  const t1 =
    m1.conversation ||
    m1.extendedTextMessage?.text ||
    m1.imageMessage?.caption ||
    m1.videoMessage?.caption;

  if (t1) return t1;

  // tombol & interaktif
  const t2 =
    m1.buttonsResponseMessage?.selectedDisplayText ||
    m1.templateButtonReplyMessage?.selectedDisplayText ||
    m1.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m1.interactiveResponseMessage?.body?.text ||
    m1.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson; // kadang JSON

  if (typeof t2 === "string") return t2;

  try {
    if (t2) {
      const parsed = JSON.parse(t2);
      return (
        parsed?.text || parsed?.id || parsed?.payload || JSON.stringify(parsed)
      );
    }
  } catch (_) {}

  return "";
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // simpan kredensial saat berubah
  sock.ev.on("creds.update", saveCreds);

  // QR & status koneksi
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQR = qr; // simpan untuk endpoint /qr
      console.clear();
      console.log("Scan QR ini di WhatsApp > Perangkat Tertaut:");
      qrcode.generate(qr, { small: false }); // besar biar mudah discan
    }

    if (connection === "open") {
      isReady = true;
      lastQR = ""; // QR tak diperlukan lagi
      logger.info("WA connected ✅");
    } else if (connection === "close") {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ code }, "WA closed. Reconnecting if possible…");
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) startWA();
      else logger.error("Logged out. Hapus folder auth & scan ulang.");
    } else if (connection) {
      logger.info({ connection }, "WA connection state…");
    }
  });

  // ==== AUTO-REPLY LOKAL (satu handler saja) ====
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return; // hindari loop

    const from = msg.key.remoteJid;
    const pushName = msg.pushName || "";
    const text = (extractText(msg) || "").trim();
    const lower = text.toLowerCase();

    // log ringan agar kelihatan apa yang diterima
    logger.info({ from, pushName, text }, "Incoming message");

    if (!text) return;

    try {
      // COMMAND ROUTER
      if (lower === "ping") {
        return await sendText(from, "pong ✅");
      }

      if (lower === "menu" || lower === "!help" || lower === "help") {
        return await sendText(
          from,
          [
            "📋 *Menu Perintah*",
            "- `ping` → tes bot",
            "- `info` → info singkat",
            "- `waktu` → jam server",
            "- `id` → JID kamu",
            "- `balas <teks>` → bot membalas teks",
            "- `foto <url>` → kirim gambar dari URL",
            "",
            "Contoh:",
            "`balas Halo juga!`",
            "`foto https://picsum.photos/600`",
          ].join("\n")
        );
      }

      if (lower === "info") {
        return await sendText(
          from,
          `👋 Hai *${
            pushName || "teman"
          }*!\nBot ini jalan (Baileys/WA Web).\nKetik *menu* untuk lihat perintah.`
        );
      }

      if (lower === "waktu") {
        const now = new Date();
        return await sendText(from, `⏰ ${now.toLocaleString()}`);
      }

      if (lower === "id") {
        return await sendText(from, `🆔 JID kamu: ${from}`);
      }

      // balas <teks>
      if (lower.startsWith("balas ")) {
        const reply = text.slice(6).trim();
        if (reply) return await sendText(from, reply);
      }

      // foto <url>
      if (lower.startsWith("foto ")) {
        const url = text.slice(5).trim();
        if (!/^https?:\/\//i.test(url)) {
          return await sendText(
            from,
            "❌ URL tidak valid. Contoh: foto https://picsum.photos/600"
          );
        }
        const resp = await fetch(url); // Node 20+/22: global fetch tersedia
        if (!resp.ok) {
          return await sendText(
            from,
            `❌ Gagal ambil gambar: ${resp.status} ${resp.statusText}`
          );
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        await delayHuman();
        return await sock.sendMessage(from, {
          image: buffer,
          caption: `📷 dari URL: ${url}`,
        });
      }

      // DEFAULT: echo
      await delayHuman();
      await sendText(from, `Echo: ${text}`);
    } catch (err) {
      logger.error({ err }, "Gagal memproses pesan masuk");
    }
  });
}

// helper kirim teks dengan jeda “manusia”
async function sendText(jid, text) {
  await delayHuman();
  return sock.sendMessage(jid, { text });
}

function delayHuman(min = 300, max = 1200) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

// Tunggu sampai ready (max 15 detik)
async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (!isReady && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!isReady) throw new Error("not-ready-timeout");
}

// Kirim aman + 1x retry jika koneksi tertutup
async function sendSafe(jid, content) {
  try {
    await waitForReady(15000);
    return await sock.sendMessage(jid, content);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("Connection Closed") || msg.includes("Sock is closed")) {
      logger.warn("Send failed: connection closed. Waiting & retrying once…");
      await waitForReady(15000);
      return await sock.sendMessage(jid, content);
    }
    throw e;
  }
}

// ==== REST BRIDGE (tes manual) ====
const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ ok: true, ready: isReady }));

// tampilkan QR di browser (SVG)
app.get("/qr", async (_, res) => {
  try {
    if (!lastQR) return res.status(404).send("QR belum tersedia");
    const svg = await QR.toString(lastQR, { type: "svg", margin: 2 });
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (e) {
    res.status(500).send("Gagal merender QR");
  }
});

// kirim teks: GET /sendText?to=62812xxxx&text=Halo
app.get("/sendText", async (req, res) => {
  try {
    let to = (req.query.to || "").trim();
    const text = (req.query.text || "").toString();
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "to & text required" });
    }
    to = to.replace(/[^\d]/g, "");
    if (!to.startsWith("62")) {
      return res.status(400).json({
        ok: false,
        error: "Gunakan format MSISDN Indonesia, mis: 62812xxxxxxx",
      });
    }
    const jid = `${to}@s.whatsapp.net`;
    await sendSafe(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    console.error("sendText error:", e);
    res
      .status(500)
      .json({ ok: false, error: String(e?.message || e), ready: isReady });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  // <-- bind ke semua interface (penting di CapRover)
  console.log("REST listening on :" + PORT);
  startWA();
});
