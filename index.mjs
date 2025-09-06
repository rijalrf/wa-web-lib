import express from "express";
import pino from "pino";
import dotenv from "dotenv";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QR from "qrcode"; // render QR ke SVG/PNG di /qr
import fs from "fs/promises";
import path from "path";

dotenv.config();

const N8N_INCOMING_URL = process.env.N8N_INCOMING_URL || "";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const logger = pino({ level: "info" });
const PORT = process.env.PORT || 3000;

// PENTING: path ini harus DIPERSIST di CapRover (mount volume)
const SESSION_DIR = process.env.SESSION_DIR || "/usr/src/app/auth";

let sock;
let isReady = false; // koneksi WA OPEN?
let lastQR = ""; // simpan QR terakhir untuk /qr
let starting = false; // guard: cegah double start
let reconnectTimer = null; // simpan timer backoff

// ===== Helper: ekstrak teks dari berbagai tipe pesan =====
function extractText(msg) {
  const m = msg?.message;
  if (!m) return "";

  const unwrap = (x) => x?.message || x;
  const m1 = unwrap(m.ephemeralMessage) || unwrap(m.viewOnceMessageV2) || m;

  const t1 =
    m1.conversation ||
    m1.extendedTextMessage?.text ||
    m1.imageMessage?.caption ||
    m1.videoMessage?.caption;

  if (t1) return t1;

  const t2 =
    m1.buttonsResponseMessage?.selectedDisplayText ||
    m1.templateButtonReplyMessage?.selectedDisplayText ||
    m1.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m1.interactiveResponseMessage?.body?.text ||
    m1.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

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

async function ensureSessionDir() {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  } catch {}
}

function scheduleReconnect(fn, ms = 1500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    fn();
  }, ms);
}

async function startWA() {
  if (starting) return;
  starting = true;
  await ensureSessionDir();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // kita handle sendiri
    browser: ["Windows", "Chrome", "120.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQR = qr;
      console.clear();
      console.log("Scan QR di WhatsApp > Perangkat Tertaut:");
      qrcode.generate(qr, { small: false });
      logger.info("QR updated — buka /qr untuk scan.");
    }

    if (connection === "open") {
      isReady = true;
      lastQR = "";
      starting = false;
      logger.info("WA connected ✅");
    }

    if (connection === "close") {
      isReady = false;
      starting = false;

      // Ambil kode/penyebab close
      const code =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.status ??
        lastDisconnect?.error?.code;

      const reason = lastDisconnect?.error?.reason || lastDisconnect?.error;
      logger.warn({ code, reason }, "Connection closed");

      const loggedOut =
        code === DisconnectReason.loggedOut ||
        lastDisconnect?.error?.output?.statusCode ===
          DisconnectReason.loggedOut ||
        String(reason || "")
          .toLowerCase()
          .includes("logged out");

      if (loggedOut) {
        // Hapus sesi lalu mulai ulang → akan muncul QR baru
        logger.warn("Detected LOGGED OUT — resetting session dir…");
        try {
          await fs.rm(SESSION_DIR, { recursive: true, force: true });
          await fs.mkdir(SESSION_DIR, { recursive: true });
        } catch (e) {
          logger.error(e, "Failed to reset session dir");
        }
      }

      // backoff singkat sebelum reconnect
      scheduleReconnect(() => startWA(), 1500);
    }
  });

  // ==== AUTO-REPLY LOKAL (satu handler saja) ====
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const pushName = msg.pushName || "";
    const text = (extractText(msg) || "").trim();
    const lower = text.toLowerCase();

    logger.info({ from, pushName, text }, "Incoming message");

    // --- Forward ke n8n (fire-and-forget) ---
    if (N8N_INCOMING_URL && text) {
      try {
        await fetch(N8N_INCOMING_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Token": WEBHOOK_TOKEN,
          },
          body: JSON.stringify({
            from,
            text,
            pushName,
            messageId: msg.key.id,
            timestamp: (msg.messageTimestamp || 0) * 1000,
            isGroup: from.endsWith("@g.us"),
          }),
        });
      } catch (err) {
        logger.warn({ err }, "Gagal POST ke n8n");
      }
    }

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
          }*!\nBot ini berjalan pakai Baileys (WA Web).\nKetik *menu* untuk lihat perintah.`
        );
      }

      if (lower === "waktu") {
        const now = new Date();
        return await sendText(from, `⏰ ${now.toLocaleString()}`);
      }

      if (lower === "id") {
        return await sendText(from, `🆔 JID kamu: ${from}`);
      }

      if (lower.startsWith("balas ")) {
        const reply = text.slice(6).trim();
        if (reply) return await sendText(from, reply);
      }

      if (lower.startsWith("foto ")) {
        const url = text.slice(5).trim();
        if (!/^https?:\/\//i.test(url)) {
          return await sendText(
            from,
            "❌ URL tidak valid. Contoh: foto https://picsum.photos/600"
          );
        }
        const resp = await fetch(url);
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

// ==== REST BRIDGE ====
const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ ok: true, ready: isReady }));

// tampilkan QR di browser (SVG)
app.get("/qr", async (_, res) => {
  try {
    if (isReady) return res.status(200).send("Sudah tersambung. Tidak ada QR.");
    if (!lastQR)
      return res.status(202).send("Menunggu QR, coba lagi sebentar…");
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

// reset sesi manual (opsional)
app.post("/reset-session", async (_, res) => {
  try {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    await fs.mkdir(SESSION_DIR, { recursive: true });
    lastQR = "";
    isReady = false;
    starting = false;
    scheduleReconnect(() => startWA(), 300); // trigger start ulang cepat
    res.json({ ok: true, message: "Session cleared. Reload /qr to scan." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("REST listening on :" + PORT);
  startWA().catch((e) => logger.error(e));
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try {
      await sock?.ws?.close();
    } catch {}
    process.exit(0);
  });
}
