// server.js
// Backend Baileys para Dropship Perú
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

dotenv.config();

// ============================================================
// Configuración
// ============================================================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

if (!API_KEY) {
  console.error("❌ API_KEY no está definida en .env");
  process.exit(1);
}

// ============================================================
// Express setup
// ============================================================
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

// ============================================================
// Estado de la conexión WhatsApp
// ============================================================
let sock = null;
let isConnected = false;
let lastQr = null;
let connectionAttempts = 0;

// ============================================================
// Middleware de auth por API Key
// ============================================================
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ============================================================
// Normalizar número peruano al formato de WhatsApp
// ============================================================
function normalizePhone(phone) {
  if (!phone) return null;

  // Quitar todo lo que no sea número
  let clean = String(phone).replace(/\D/g, "");

  // Si empieza con 51 y tiene 11 dígitos, ya está bien
  if (clean.length === 11 && clean.startsWith("51")) {
    return clean;
  }

  // Si tiene 9 dígitos (celular peruano), agregar 51
  if (clean.length === 9) {
    return `51${clean}`;
  }

  // Si empieza con 0051
  if (clean.length === 13 && clean.startsWith("0051")) {
    return clean.substring(2);
  }

  return clean;
}

// ============================================================
// Delay helper (evitar spam / ban)
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Conectar a WhatsApp
// ============================================================
async function connectToWhatsApp() {
  try {
    connectionAttempts++;
    console.log(`\n🔄 Intento de conexión #${connectionAttempts}`);

    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📱 Usando Baileys versión: ${version.join(".")}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // usamos qrcode-terminal manualmente
      logger: pino({ level: "silent" }),
      browser: ["Dropship Peru Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false, // menos sospechoso
    });

    // Guardar credenciales cuando cambien
    sock.ev.on("creds.update", saveCreds);

    // Escuchar cambios de conexión
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Mostrar QR si viene
      if (qr) {
        lastQr = qr;
        console.log("\n╔════════════════════════════════════════════╗");
        console.log("║  📱 ESCANEA ESTE QR CON WHATSAPP           ║");
        console.log("╚════════════════════════════════════════════╝\n");
        qrcode.generate(qr, { small: true });
        console.log(
          "\n💡 WhatsApp → Menú (⋮) → Dispositivos vinculados → Vincular"
        );
        console.log(
          `🌐 O abre en el navegador: /qr para ver el QR como imagen\n`
        );
      }

      // Manejo de cierre de conexión
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `\n🔌 Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`
        );

        isConnected = false;

        if (shouldReconnect) {
          console.log("⏳ Reintentando en 5 segundos...");
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log(
            "\n❌ Sesión cerrada por el usuario. Borra la carpeta 'auth/' y reinicia para escanear un nuevo QR.\n"
          );
        }
      } else if (connection === "open") {
        console.log("\n╔════════════════════════════════════════════╗");
        console.log("║  ✅ WhatsApp conectado exitosamente!        ║");
        console.log("╚════════════════════════════════════════════╝\n");
        isConnected = true;
        lastQr = null;
        connectionAttempts = 0;
      } else if (connection === "connecting") {
        console.log("⏳ Conectando a WhatsApp...");
      }
    });
  } catch (err) {
    console.error("❌ Error en connectToWhatsApp:", err);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

// Health check (público, para Railway)
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "dropship-whatsapp-bot",
    connected: isConnected,
    hasQr: !!lastQr,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Estado detallado (público)
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    hasQr: !!lastQr,
    uptime: process.uptime(),
    attempts: connectionAttempts,
  });
});

// ============================================================
// QR como imagen HTML (para escanear desde navegador)
// ============================================================
app.get("/qr", async (req, res) => {
  try {
    // Ya está conectado → mostrar página de éxito
    if (isConnected) {
      return res.send(`
        <html>
          <head>
            <title>WhatsApp Bot - Conectado</title>
            <meta http-equiv="refresh" content="10">
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                color: #166534;
              }
              .card {
                background: white;
                padding: 48px 40px;
                border-radius: 20px;
                box-shadow: 0 8px 30px rgba(0,0,0,0.08);
                text-align: center;
                max-width: 400px;
              }
              h1 { margin: 0 0 10px; font-size: 28px; }
              p { margin: 8px 0; color: #6b7280; }
              .badge {
                display: inline-block;
                background: #10b981;
                color: white;
                padding: 8px 20px;
                border-radius: 999px;
                font-weight: 600;
                margin-top: 16px;
                font-size: 14px;
              }
              .emoji {
                font-size: 64px;
                margin-bottom: 16px;
                display: block;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <span class="emoji">✅</span>
              <h1>WhatsApp Conectado</h1>
              <p>El bot está listo para enviar mensajes</p>
              <div class="badge">● ONLINE</div>
            </div>
          </body>
        </html>
      `);
    }

    // Aún no hay QR generado
    if (!lastQr) {
      return res.send(`
        <html>
          <head>
            <title>WhatsApp Bot - Generando QR</title>
            <meta http-equiv="refresh" content="3">
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                color: #92400e;
              }
              .card {
                background: white;
                padding: 48px 40px;
                border-radius: 20px;
                box-shadow: 0 8px 30px rgba(0,0,0,0.08);
                text-align: center;
              }
              .spinner {
                border: 4px solid #fef3c7;
                border-top: 4px solid #f59e0b;
                border-radius: 50%;
                width: 48px;
                height: 48px;
                animation: spin 1s linear infinite;
                margin: 0 auto 20px;
              }
              @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
              }
              h1 { margin: 0 0 10px; font-size: 24px; }
              p { margin: 4px 0; color: #6b7280; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="spinner"></div>
              <h1>Generando QR...</h1>
              <p>Esta página se recargará automáticamente</p>
            </div>
          </body>
        </html>
      `);
    }

    // Generar QR como Data URL (base64)
    const qrDataUrl = await QRCode.toDataURL(lastQr, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    res.send(`
      <html>
        <head>
          <title>WhatsApp Bot - Escanear QR</title>
          <meta http-equiv="refresh" content="20">
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
              background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
              color: #111827;
              box-sizing: border-box;
            }
            .card {
              background: white;
              padding: 40px;
              border-radius: 24px;
              box-shadow: 0 8px 30px rgba(0,0,0,0.08);
              text-align: center;
              max-width: 500px;
              width: 100%;
              box-sizing: border-box;
            }
            h1 {
              margin: 0 0 8px;
              font-size: 24px;
              font-weight: 700;
            }
            .subtitle {
              color: #6b7280;
              margin-bottom: 24px;
              font-size: 14px;
            }
            img {
              border: 8px solid #f3f4f6;
              border-radius: 16px;
              display: block;
              margin: 0 auto;
              max-width: 100%;
              height: auto;
            }
            .steps {
              text-align: left;
              margin-top: 24px;
              padding: 20px;
              background: #f9fafb;
              border-radius: 12px;
              font-size: 14px;
              color: #4b5563;
            }
            .steps ol {
              margin: 0;
              padding-left: 20px;
            }
            .steps li {
              margin: 6px 0;
              line-height: 1.5;
            }
            .refresh {
              margin-top: 16px;
              font-size: 12px;
              color: #9ca3af;
            }
            .brand {
              margin-top: 8px;
              font-size: 12px;
              color: #d1d5db;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>📱 Escanea el QR con WhatsApp</h1>
            <p class="subtitle">Dropship Perú Bot</p>
            <img src="${qrDataUrl}" alt="QR Code de WhatsApp" />
            <div class="steps">
              <ol>
                <li>Abre <strong>WhatsApp</strong> en tu celular</li>
                <li>Toca el menú (⋮) → <strong>Dispositivos vinculados</strong></li>
                <li>Toca <strong>Vincular un dispositivo</strong></li>
                <li>Apunta la cámara a este QR</li>
              </ol>
            </div>
            <p class="refresh">🔄 Auto-refresh cada 20 segundos</p>
            <p class="brand">Dropship Perú · WhatsApp Bot</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error generando QR:", err);
    res.status(500).send(`Error generando QR: ${err.message}`);
  }
});

// Enviar mensaje (protegido con API key)
app.post("/send", requireApiKey, async (req, res) => {
  try {
    const { phone, message } = req.body;

    // Validación
    if (!phone || !message) {
      return res.status(400).json({
        error: "Faltan campos: phone y message son requeridos",
      });
    }

    if (typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({
        error: "El mensaje no puede estar vacío",
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        error: "El mensaje es demasiado largo (máx 4000 caracteres)",
      });
    }

    // Verificar conexión
    if (!isConnected || !sock) {
      return res.status(503).json({
        error: "WhatsApp no está conectado. Escanea el QR primero.",
        needsQr: !!lastQr,
      });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || normalizedPhone.length < 10) {
      return res.status(400).json({
        error: "Número de teléfono inválido",
        phone,
      });
    }

    const jid = `${normalizedPhone}@s.whatsapp.net`;

    // Verificar si el número existe en WhatsApp
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      return res.status(404).json({
        error: "El número no tiene WhatsApp",
        phone: normalizedPhone,
      });
    }

    // Delay anti-spam (2 segundos)
    await sleep(2000);

    // Enviar mensaje
    const sent = await sock.sendMessage(result.jid, { text: message });

    console.log(`✅ Enviado a ${normalizedPhone} → "${message.substring(0, 50)}..."`);

    res.json({
      success: true,
      phone: normalizedPhone,
      messageId: sent?.key?.id ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err);
    res.status(500).json({
      error: "Error enviando mensaje",
      details: err.message,
    });
  }
});

// Verificar si un número tiene WhatsApp (protegido)
app.post("/check", requireApiKey, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Falta el campo phone" });
    }

    if (!isConnected || !sock) {
      return res.status(503).json({ error: "WhatsApp no está conectado" });
    }

    const normalizedPhone = normalizePhone(phone);
    const jid = `${normalizedPhone}@s.whatsapp.net`;
    const [result] = await sock.onWhatsApp(jid);

    res.json({
      phone: normalizedPhone,
      exists: !!result?.exists,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forzar reconexión (protegido)
app.post("/reconnect", requireApiKey, async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        // Ignorar error si ya está desconectado
      }
    }
    isConnected = false;
    lastQr = null;
    setTimeout(connectToWhatsApp, 1000);
    res.json({ success: true, message: "Reconectando..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Iniciar servidor
// ============================================================
app.listen(PORT, () => {
  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║  🚀 Dropship WhatsApp Bot                  ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`\n🌐 Servidor: http://localhost:${PORT}`);
  console.log(`🔑 API_KEY: ${API_KEY.substring(0, 15)}...`);
  console.log(`🎯 CORS: ${FRONTEND_URL}\n`);
});

// Iniciar conexión WhatsApp
connectToWhatsApp().catch((err) => {
  console.error("❌ Error crítico iniciando WhatsApp:", err);
});

// Manejo de cierre limpio
process.on("SIGINT", async () => {
  console.log("\n👋 Cerrando servidor...");
  if (sock) {
    try {
      await sock.end();
    } catch (e) {
      // Ignorar
    }
  }
  process.exit(0);
});