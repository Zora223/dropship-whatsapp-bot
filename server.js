// server.js - Dropship Perú v20.8
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

dotenv.config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

if (!API_KEY) {
  console.error("API_KEY no está definida en .env");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(
  cors({
    origin:
      FRONTEND_URL === "*"
        ? "*"
        : FRONTEND_URL.split(",").map((u) => u.trim()),
  })
);

let sock = null;
let isConnected = false;
let lastQr = null;
let connectionAttempts = 0;

const messageQueue = [];
let isProcessingQueue = false;
const MIN_DELAY_BETWEEN_MESSAGES = 4000;
let lastMessageSentAt = 0;

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function normalizePhone(phone) {
  if (!phone) return null;
  let clean = String(phone).replace(/\D/g, "");
  if (clean.length === 11 && clean.startsWith("51")) return clean;
  if (clean.length === 9) return "51" + clean;
  if (clean.length === 13 && clean.startsWith("0051")) return clean.substring(2);
  if (clean.length === 12 && clean.startsWith("515")) return clean.substring(2);
  return clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanAuthAndReconnect() {
  console.log("\nAuto-limpiando carpeta auth por sesion expulsada...");
  const authPath = path.resolve("auth");
  try {
    await fs.rm(authPath, { recursive: true, force: true });
    console.log("Carpeta auth eliminada");
  } catch (e) {
    console.log("Error borrando auth:", e.message);
  }
  sock = null;
  isConnected = false;
  lastQr = null;
  connectionAttempts = 0;
  console.log("Reconectando en 3 segundos...\n");
  setTimeout(connectToWhatsApp, 3000);
}

async function connectToWhatsApp() {
  try {
    connectionAttempts++;
    console.log("\nIntento de conexion #" + connectionAttempts);

    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log("Baileys version: " + version.join("."));

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQr = qr;
        console.log("\n=== ESCANEA ESTE QR CON WHATSAPP ===\n");
        qrcode.generate(qr, { small: true });
        console.log("\nO abre /qr en el navegador\n");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log("\nConexion cerrada. Codigo: " + statusCode + ". LoggedOut: " + isLoggedOut);
        isConnected = false;

        if (isLoggedOut) {
          console.log("Sesion expulsada por WhatsApp");
          console.log("Auto-recovery: limpiando auth y regenerando QR...");
          cleanAuthAndReconnect();
        } else {
          console.log("Reintentando en 5 segundos...");
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === "open") {
        console.log("\n=== WhatsApp conectado exitosamente ===\n");
        isConnected = true;
        lastQr = null;
        connectionAttempts = 0;
        processMessageQueue();
      } else if (connection === "connecting") {
        console.log("Conectando...");
      }
    });
  } catch (err) {
    console.error("Error en connectToWhatsApp:", err);
    setTimeout(connectToWhatsApp, 10000);
  }
}

async function processMessageQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0 && isConnected && sock) {
    const item = messageQueue.shift();
    try {
      const timeSinceLastMessage = Date.now() - lastMessageSentAt;
      if (timeSinceLastMessage < MIN_DELAY_BETWEEN_MESSAGES) {
        await sleep(MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMessage);
      }
      const { jid, message, resolve } = item;
      const sent = await sock.sendMessage(jid, { text: message });
      lastMessageSentAt = Date.now();
      console.log("Enviado a " + jid.split("@")[0]);
      resolve(sent);
    } catch (err) {
      console.error("Error enviando desde cola:", err.message);
      item.reject(err);
    }
  }
  isProcessingQueue = false;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "dropship-whatsapp-bot",
    version: "v20.8",
    connected: isConnected,
    hasQr: !!lastQr,
    queueSize: messageQueue.length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    hasQr: !!lastQr,
    uptime: process.uptime(),
    attempts: connectionAttempts,
    queueSize: messageQueue.length,
  });
});

app.get("/qr", async (req, res) => {
  try {
    if (isConnected) {
      const html = '<!DOCTYPE html><html><head><title>Conectado</title><meta http-equiv="refresh" content="10"><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}.card{background:white;padding:48px;border-radius:20px;box-shadow:0 8px 30px rgba(0,0,0,0.1);text-align:center}h1{color:#166534}.badge{background:#10b981;color:white;padding:8px 20px;border-radius:999px;font-weight:600}</style></head><body><div class="card"><h1>WhatsApp Conectado</h1><p>El bot esta listo</p><div class="badge">ONLINE</div></div></body></html>';
      return res.send(html);
    }

    if (!lastQr) {
      const html = '<!DOCTYPE html><html><head><title>Generando QR</title><meta http-equiv="refresh" content="3"><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fef3c7}.card{background:white;padding:48px;border-radius:20px;text-align:center}.spinner{border:4px solid #fef3c7;border-top:4px solid #f59e0b;border-radius:50%;width:48px;height:48px;animation:spin 1s linear infinite;margin:0 auto 20px}@keyframes spin{100%{transform:rotate(360deg)}}</style></head><body><div class="card"><div class="spinner"></div><h1>Generando QR...</h1><p>Recargando automaticamente</p></div></body></html>';
      return res.send(html);
    }

    const qrDataUrl = await QRCode.toDataURL(lastQr, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    const html = '<!DOCTYPE html><html><head><title>Escanear QR</title><meta http-equiv="refresh" content="20"><style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;background:#f9fafb}.card{background:white;padding:40px;border-radius:24px;box-shadow:0 8px 30px rgba(0,0,0,0.08);text-align:center;max-width:500px}h1{margin:0 0 8px}img{border:8px solid #f3f4f6;border-radius:16px;max-width:100%}.steps{text-align:left;margin-top:24px;padding:20px;background:#f9fafb;border-radius:12px;font-size:14px}</style></head><body><div class="card"><h1>Escanea el QR con WhatsApp</h1><p>Dropship Peru Bot</p><img src="' + qrDataUrl + '" /><div class="steps"><ol><li>Abre WhatsApp en tu celular</li><li>Menu (tres puntos) - Dispositivos vinculados</li><li>Vincular un dispositivo</li><li>Apunta al QR</li></ol></div></div></body></html>';
    res.send(html);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/send", requireApiKey, async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: "Faltan campos: phone y message" });
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Mensaje vacio" });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: "Mensaje muy largo (max 4000)" });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({
        error: "WhatsApp no está conectado. Escanea el QR primero.",
        needsQr: !!lastQr,
      });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || normalizedPhone.length < 10) {
      return res.status(400).json({ error: "Numero invalido", phone });
    }

    const jid = normalizedPhone + "@s.whatsapp.net";
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      return res.status(404).json({
        error: "El número no tiene WhatsApp",
        phone: normalizedPhone,
      });
    }

    const sent = await new Promise((resolve, reject) => {
      messageQueue.push({ jid: result.jid, message, resolve, reject });
      processMessageQueue();
    });

    res.json({
      success: true,
      phone: normalizedPhone,
      messageId: sent?.key?.id ?? null,
      queuePosition: messageQueue.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error enviando:", err);
    res.status(500).json({ error: "Error enviando", details: err.message });
  }
});

app.post("/check", requireApiKey, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Falta phone" });
    if (!isConnected || !sock) return res.status(503).json({ error: "No conectado" });

    const normalizedPhone = normalizePhone(phone);
    const jid = normalizedPhone + "@s.whatsapp.net";
    const [result] = await sock.onWhatsApp(jid);
    res.json({ phone: normalizedPhone, exists: !!result?.exists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reconnect", requireApiKey, async (req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch (e) {}
    }
    isConnected = false;
    lastQr = null;
    setTimeout(connectToWhatsApp, 1000);
    res.json({ success: true, message: "Reconectando..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset-auth", requireApiKey, async (req, res) => {
  try {
    console.log("\nRESET AUTH manual iniciado...");
    if (sock) {
      try { await sock.end(); } catch (e) {}
    }
    await cleanAuthAndReconnect();
    res.json({
      success: true,
      message: "Auth reseteado. En 5-10 seg aparecera QR nuevo en /qr",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("\n=== Dropship WhatsApp Bot v20.8 ===");
  console.log("Puerto: " + PORT);
  console.log("API_KEY: " + API_KEY.substring(0, 15) + "...");
  console.log("Rate limit: " + MIN_DELAY_BETWEEN_MESSAGES + "ms entre mensajes\n");
});

connectToWhatsApp().catch((err) => {
  console.error("Error critico:", err);
});

process.on("SIGINT", async () => {
  console.log("\nCerrando servidor...");
  if (sock) {
    try { await sock.end(); } catch (e) {}
  }
  process.exit(0);
});