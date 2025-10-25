import express from "express";
import pino from "pino";
import dotenv from "dotenv";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QR from "qrcode";
import fs from "fs/promises";
import os from "os";

dotenv.config();

const N8N_INCOMING_URL = process.env.N8N_INCOMING_URL || "";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const SEND_TOKEN = process.env.SEND_TOKEN || ""; // auth utk /send-private & /send-group
const FALLBACK_TEXT_MENTION =
  (process.env.FALLBACK_TEXT_MENTION ?? "true").toLowerCase() !== "false";
const PORT = process.env.PORT || 3000;
const logger = pino({ level: "info" });

// PENTING: path ini harus DIPERSIST di CapRover (mount volume)
const SESSION_DIR = process.env.SESSION_DIR || "/usr/src/app/auth";

// Notifikasi UP targets
const UP_PRIVATE = process.env.UP_PRIVATE || ""; // 62...@s.whatsapp.net
const UP_GROUP = process.env.UP_GROUP || ""; // 120...@g.us
const SERVER_NAME =
  process.env.SERVER_NAME || process.env.APP_NAME || os.hostname();

// state
let sock;
let isReady = false;
let lastQR = "";
let starting = false;
let reconnectTimer = null;
let announcedBoot = false;

// ===== Helpers =====
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

function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

function getMentionedJids(msg) {
  const ci =
    msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo ||
    msg?.message?.videoMessage?.contextInfo ||
    msg?.message?.documentMessage?.contextInfo ||
    msg?.message?.stickerMessage?.contextInfo ||
    {};
  const mentions = ci?.mentionedJid || [];
  return Array.isArray(mentions)
    ? mentions.map((j) => jidNormalizedUser(String(j || "")))
    : [];
}

function isMentioningMe(msg, myJid) {
  if (!myJid) return false;
  const me = jidNormalizedUser(String(myJid));
  return getMentionedJids(msg).includes(me);
}

function normalizePrivateToJid(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (s.endsWith("@s.whatsapp.net")) return jidNormalizedUser(s);

  s = s.replace(/[^\d]/g, "");
  if (s.startsWith("0")) s = "62" + s.slice(1);
  if (!/^62\d{6,15}$/.test(s)) return null;
  return jidNormalizedUser(`${s}@s.whatsapp.net`);
}

function isGroupJidStrict(jid) {
  return typeof jid === "string" && /@g\.us$/.test(jid);
}

function nowWIB() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const fixed = value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(2);
  return `${fixed} ${units[i]}`;
}

async function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const stats = {
    memory: {
      used: formatBytes(totalMem - freeMem),
      total: formatBytes(totalMem),
    },
    cpu: {
      cores: os.cpus()?.length || 1,
      load: (os.loadavg?.()[0] ?? 0).toFixed(2),
    },
    storage: null,
  };

  try {
    if (typeof fs.statfs === "function") {
      const { bsize, blocks, bfree } = await fs.statfs("/usr/src/app");
      const blockSize = Number(bsize) || 0;
      const totalBlocks = Number(blocks) || 0;
      const freeBlocks = Number(bfree) || 0;
      const totalBytes = blockSize * totalBlocks;
      const usedBytes = totalBytes - blockSize * freeBlocks;
      stats.storage = {
        used: formatBytes(usedBytes),
        total: formatBytes(totalBytes),
      };
    }
  } catch (err) {
    logger.warn({ err }, "Failed to read storage stats");
  }

  return stats;
}

async function announceUp() {
  const stats = await getSystemStats();
  const lines = [
    `*Server Up and Running*`,
    `Server : ${SERVER_NAME}`,
    `Waktu  : ${nowWIB()} (WIB)`,
    `Status : RUNNING`,
  ];

  if (stats?.cpu) {
    lines.push(`CPU    : ${stats.cpu.cores} core | load ${stats.cpu.load}`);
  }
  if (stats?.memory) {
    lines.push(`Memory : ${stats.memory.used} / ${stats.memory.total}`);
  }
  if (stats?.storage) {
    lines.push(`Storage: ${stats.storage.used} / ${stats.storage.total}`);
  }

  const msg = lines.join("\n");

  const targets = [UP_PRIVATE, UP_GROUP].filter(Boolean);
  for (const jid of targets) {
    try {
      await sendSafe(jid, { text: msg });
    } catch (e) {
      logger.warn({ jid, e }, "announceUp failed");
    }
  }
}

// reset helpers (anti-EBUSY)
async function closeSocketGracefully() {
  try {
    await sock?.logout?.().catch(() => {});
  } catch {}
  try {
    await sock?.ws?.close?.();
  } catch {}
  try {
    sock = null;
  } catch {}
}

async function forceRemoveDir(dir, attempts = 5) {
  const bak = `${dir}.bak-${Date.now()}`;
  try {
    await fs.rename(dir, bak).catch(() => {});
  } catch {}
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(bak, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300 + i * 200));
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

// ===== WhatsApp socket =====
async function startWA() {
  if (starting) return;
  starting = true;
  try {
    await ensureSessionDir();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version, isLatest }, "Using WhatsApp Web version");
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Windows", "Chrome", "120.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 10_000,
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    starting = false;
    logger.error({ err }, "startWA failed");
    scheduleReconnect(() => startWA(), 2000);
    return;
  }

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

      if (!announcedBoot) {
        announcedBoot = true;
        announceUp().catch((e) => logger.warn({ e }, "announceUp error"));
      }
    }

    if (connection === "close") {
      isReady = false;
      starting = false;

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
        logger.warn("Detected LOGGED OUT — resetting session dir…");
        try {
          await closeSocketGracefully();
          await forceRemoveDir(SESSION_DIR);
          await fs.mkdir(SESSION_DIR, { recursive: true });
        } catch (e) {
          logger.error(e, "Failed to reset session dir");
        }
      }

      scheduleReconnect(() => startWA(), 1500);
    }
  });

  // ==== message handler ====
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const pushName = msg.pushName || "";
    const text = (extractText(msg) || "").trim();
    const lower = text.toLowerCase();

    logger.info({ from, pushName, text }, "Incoming message");

    // forward ke n8n
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

    // di grup: wajib mention
    if (isGroupJid(from)) {
      const myJid = sock?.user?.id;
      const iAmMentioned = isMentioningMe(msg, myJid);

      let fallbackMention = false;
      if (FALLBACK_TEXT_MENTION && !iAmMentioned && text) {
        const bare = jidNormalizedUser(String(myJid || "")); // 628xx...@s.whatsapp.net
        const myMsisdn = bare.split("@")[0];
        const last7 = myMsisdn.slice(-7);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        fallbackMention =
          new RegExp(esc(last7)).test(text) || /\b(bot|wa-?bot)\b/i.test(text);
      }

      if (!iAmMentioned && !fallbackMention) return;
    }

    try {
      if (lower === "ping") return await sendText(from, "pong ✅");

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
            "Catatan: di *grup*, bot hanya merespons jika *di-mention*.",
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
        return await sendText(from, `⏰ ${nowWIB()} (WIB)`);
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

      // default: diam (echo dimatikan)
      return;
    } catch (err) {
      logger.error({ err }, "Gagal memproses pesan masuk");
    }
  });
}

// send helpers
async function sendText(jid, text) {
  await delayHuman();
  return sock.sendMessage(jid, { text });
}
function delayHuman(min = 300, max = 1200) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}
async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (!isReady && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!isReady) throw new Error("not-ready-timeout");
}
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

app.get("/qr", async (_, res) => {
  try {
    if (isReady) return res.status(200).send("Sudah tersambung. Tidak ada QR.");
    if (!lastQR) {
      if (!starting) {
        startWA().catch((e) =>
          logger.error({ e }, "startWA re-run from /qr failed")
        );
      }
      return res.status(202).send("Menunggu QR, coba lagi sebentar…");
    }
    const svg = await QR.toString(lastQR, { type: "svg", margin: 2 });
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (e) {
    res.status(500).send("Gagal merender QR");
  }
});

// kirim teks: GET /sendText?to=62812xxxx&text=Halo (private only via query)
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

// POST /send-private  body: { to: "62812xxxx" | "62812xxxx@s.whatsapp.net", text: "..." }
app.post("/send-private", async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    if (SEND_TOKEN && auth !== `Bearer ${SEND_TOKEN}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const { to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "to & text required" });
    }
    const jid = normalizePrivateToJid(to);
    if (!jid) {
      return res.status(400).json({
        ok: false,
        error:
          "Format nomor tidak valid. Contoh: 62812xxxx atau 62812xxxx@s.whatsapp.net",
      });
    }
    await sendSafe(jid, { text });
    res.json({ ok: true, jid });
  } catch (e) {
    logger.error({ e }, "/send-private failed");
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /send-group  body: { gid: "1203630xxxx@g.us", text: "...", mentions?: ["62...@s.whatsapp.net", ...] }
app.post("/send-group", async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    if (SEND_TOKEN && auth !== `Bearer ${SEND_TOKEN}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const { gid, text, mentions } = req.body || {};
    if (!gid || !text) {
      return res.status(400).json({ ok: false, error: "gid & text required" });
    }
    if (!isGroupJidStrict(gid)) {
      return res.status(400).json({
        ok: false,
        error: "gid harus JID group (akhiri dengan @g.us)",
      });
    }
    const payload = { text };
    if (Array.isArray(mentions) && mentions.length) {
      payload.mentions = mentions.map((m) => jidNormalizedUser(String(m)));
    }
    await sendSafe(gid, payload);
    res.json({
      ok: true,
      gid,
      mentioned: Array.isArray(mentions) ? mentions.length : 0,
    });
  } catch (e) {
    logger.error({ e }, "/send-group failed");
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// logout (putus tanpa hapus sesi)
app.post("/logout", async (_, res) => {
  try {
    await closeSocketGracefully();
    lastQR = "";
    isReady = false;
    starting = false;
    scheduleReconnect(() => startWA(), 300);
    res.json({ ok: true, message: "Logged out. Open /qr to scan new code." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// reset sesi (aman anti-EBUSY)
app.post("/reset-session", async (_, res) => {
  try {
    await closeSocketGracefully();
    await forceRemoveDir(SESSION_DIR);
    await fs.mkdir(SESSION_DIR, { recursive: true });
    lastQR = "";
    isReady = false;
    starting = false;
    announcedBoot = false;
    scheduleReconnect(() => startWA(), 300);
    res.json({ ok: true, message: "Session cleared. Reload /qr to scan." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("REST listening on :" + PORT);
  startWA().catch((e) => logger.error(e));
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try {
      await sock?.ws?.close();
    } catch {}
    process.exit(0);
  });
}
