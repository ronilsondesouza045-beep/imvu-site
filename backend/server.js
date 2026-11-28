import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocket, WebSocketServer } from "ws";
import { RadarTracker } from "./src/tracker.js";
import { safeNick } from "./src/imvu.js";
import { pushAvailable, pushPublicKey } from "./src/push.js";
import { musicBot } from "./src/musicBot.js";
import { radioStream } from "./src/radioStream.js";
import { initTelegramBot } from "./src/telegramBot.js";
import { CinemaService } from "./src/cinema.js";
import { SITE_URL } from "./src/site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const MAX_WATCHERS = Math.max(1, Number(process.env.MAX_WATCHERS) || 20);
const VERSION = "1.0.0";
const log = {
  info: (...args) => console.log(new Date().toISOString(), "[info]", ...args),
  warn: (...args) => console.warn(new Date().toISOString(), "[warn]", ...args),
  error: (...args) => console.error(new Date().toISOString(), "[error]", ...args),
};

const tracker = new RadarTracker({
  username: process.env.IMVU_USER,
  password: process.env.IMVU_PASS,
  log,
});

// Bot do Telegram: le/grava telegram_alvos e envia alertas quando o
// tracker detecta troca de sala (hook chamado dentro do setRoom).
const telegram = initTelegramBot({ tracker, log });
tracker.onRoomChange = (track, previousRoom) => telegram.notifyRoomChange(track, previousRoom);

// Modo Cinema: observa o chat classico sem entrar na sala (bot invisivel).
const cinema = new CinemaService({ tracker, log });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const allowedOrigins = String(process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  })
);
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "imvu-radar-backend",
    version: VERSION,
    uptime: Math.round(process.uptime()),
    siteUrl: SITE_URL,
    ...tracker.stats(),
    telegram: telegram.stats(),
    cinema: cinema.stats(),
    now: Date.now(),
  });
});

const requestBase = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req?.headers?.["x-forwarded-proto"] || (req?.secure ? "https" : "http")).split(",")[0].trim();
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`;
};
const radioUrlFor = (req) => `${requestBase(req)}/radio.mp3`;

app.get("/api/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    bot: { ...musicBot.status(), radioUrl: radioUrlFor(req) },
  });
});

app.get("/api/resolve", async (req, res) => {
  const nick = safeNick(req.query.nick);
  if (!nick) {
    res.status(400).json({ error: "nick obrigatorio" });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const person = await tracker.api.resolve(nick);
    if (!person) {
      res.status(404).json({ error: "nick nao encontrado" });
      return;
    }
    res.json({ ok: true, target: person });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// Perfil completo para o modal do site (aceita nick ou cid).
app.get("/api/perfil/:nick", async (req, res) => {
  const raw = String(req.params.nick || "").trim();
  if (!raw) {
    res.status(400).json({ error: "nick ou cid obrigatorio" });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const profile = await tracker.api.profile(raw);
    if (!profile) {
      res.status(404).json({ error: "perfil nao encontrado" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ok: true, profile });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/look/:nick", async (req, res) => {
  const raw = String(req.params.nick || "").trim();
  if (!raw) {
    res.status(400).json({ error: "nick obrigatorio" });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const look = await tracker.api.extractLook(raw);
    if (!look) {
      res.status(404).json({ error: "nick nao encontrado" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=120");
    res.json({ ok: true, ...look });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/push/key", (_req, res) => {
  res.json({ enabled: pushAvailable(), key: pushPublicKey() });
});

// ---------------- Music Bot / Radio ----------------

const botActionTimes = new Map();

function allowBotAction(key, intervalMs) {
  const now = Date.now();
  const previous = botActionTimes.get(key) || 0;
  if (now - previous < intervalMs) return false;
  botActionTimes.set(key, now);
  if (botActionTimes.size > 500) {
    const oldest = botActionTimes.keys().next().value;
    if (oldest) botActionTimes.delete(oldest);
  }
  return true;
}

app.get("/api/bot/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, status: { ...musicBot.status(), radioUrl: radioUrlFor(req) } });
});

app.post("/api/bot/play", async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || "unknown");
  if (!allowBotAction(`play:${ip}`, 3_000)) {
    res.status(429).json({ ok: false, error: "Aguarde alguns segundos antes de pedir outra música." });
    return;
  }

  const query = String(req.body?.query || "").trim().slice(0, 160);
  if (!query) {
    res.status(400).json({ ok: false, error: "Digite o nome da música." });
    return;
  }

  const status = musicBot.status();
  if (!status.connected) {
    res.status(409).json({
      ok: false,
      error: "Ative o DJ Bot em uma sala antes de pedir música.",
      status,
    });
    return;
  }

  try {
    const result = await musicBot.enqueuePlay(query, { source: "site" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...result, status: musicBot.status() });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error?.message || "Não consegui buscar essa música.",
      status: musicBot.status(),
    });
  }
});

// Stream MP3 contínuo por sala (o media_player do IMVU aponta para cá).
app.get("/api/radio/:roomId/:file", (req, res) => {
  radioStream.handleRequest(req, res, req.params.roomId, req.params.file);
});

app.get("/radio.mp3", (req, res) => {
  // Stream contínuo: nunca responde 404; sem música toca silêncio em loop.
  req.setTimeout(0);
  res.setTimeout(0);
  radioStream.handlePublicRequest(req, res, String(musicBot.roomId || ""));
});

app.post("/api/bot/join", async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || "unknown");
  if (!allowBotAction(`join:${ip}`, 8_000)) {
    res.status(429).json({ ok: false, error: "Aguarde alguns segundos antes de mover o bot de novo." });
    return;
  }

  const roomId = String(req.body?.roomId || "").trim();
  if (!/^\d+-\d+$/.test(roomId)) {
    res.status(400).json({ ok: false, error: "ID de sala invalido. Use o formato 123456-1." });
    return;
  }

  try {
    const status = await musicBot.join(roomId);
    res.json({ ok: true, status });
  } catch (error) {
    const status = musicBot.status();
    const code = status.configured ? 502 : 503;
    res.status(code).json({
      ok: false,
      error: error?.message || "Falha ao entrar na sala.",
      status,
    });
  }
});

app.post("/api/bot/leave", async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || "unknown");
  if (!allowBotAction(`leave:${ip}`, 2_500)) {
    res.status(429).json({ ok: false, error: "Aguarde um instante para desconectar." });
    return;
  }

  try {
    const status = await musicBot.leave({ logout: true });
    res.json({ ok: true, status });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error?.message || "Falha ao desconectar o bot.",
      status: musicBot.status(),
    });
  }
});

app.get("/api/avatar", async (req, res) => {
  const url = String(req.query.u || "");
  if (!url) {
    res.status(400).json({ error: "parametro u obrigatorio" });
    return;
  }
  const image = await tracker.api.fetchImage(url);
  if (image.error) {
    res.status(image.status || 502).json({ error: image.error });
    return;
  }
  res.setHeader("Content-Type", image.contentType || "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(image.buffer);
});

// Modo Cinema: fundo 2D da sala + roster (o chat vem pelo WebSocket).
app.get("/api/sala-2d/:roomId", async (req, res) => {
  const roomId = String(req.params.roomId || "").trim();
  if (!/^\d+-\d+$/.test(roomId)) {
    res.status(400).json({ error: "ID de sala invalido. Use o formato 123456-1." });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const [info, people, chatEnv] = await Promise.all([
      tracker.api.roomInfo(roomId).catch(() => null),
      tracker.api.roster(roomId, 0).catch(() => []),
      tracker.api.getJson(`/chat/chat-${roomId}`).catch(() => null),
    ]);
    if (!info) {
      res.status(404).json({ error: "sala nao encontrada" });
      return;
    }

    const banned = new Set([String(tracker.api.cid || "")]);
    const botCid = musicBot.client?.rest?.cid;
    if (botCid) banned.add(String(botCid));

    const occupants = people
      .filter((person) => person?.cid && !banned.has(String(person.cid)))
      .map((person) => ({
        cid: person.cid,
        username: person.username,
        displayName: person.displayName,
        avatar: person.avatar || "",
        portrait: person.avatarPortrait || person.portrait || "",
        lookImage: person.lookImage || "",
        lookThumbnail: person.lookThumbnail || "",
        seatNumber: person.seatNumber || 0,
        isVip: Boolean(person.isVip),
        isAp: Boolean(person.isAp),
        online: Boolean(person.online),
      }));

    const chatNode = Object.values(chatEnv?.denormalized || {}).find(
      (node) => node?.data?.imq_queue
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      room: {
        roomId,
        name: info.name || `Sala ${roomId}`,
        privacy: info.privacy,
        privacyLabel: info.privacyLabel,
        owner: info.owner,
        occupancy: Math.max(Number(info.occupancy) || 0, occupants.length),
        capacity: info.capacity,
        image: info.render || info.cover || "",
        thumbnail: info.cover || "",
        chat: Boolean(chatNode?.data?.imq_queue),
        occupants,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// Proxy dos assets 3D do IMVU (mesh JSON, texturas) com a sessao do bot.
app.get("/api/sala-3d/asset", async (req, res) => {
  const raw = String(req.query.url || "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    res.status(400).json({ error: "url invalida" });
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "imvu.com" && !host.endsWith(".imvu.com")) ||
    !parsed.pathname.startsWith("/asset/")
  ) {
    res.status(400).json({ error: "asset nao permitido" });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const headers = { "User-Agent": "Mozilla/5.0", Accept: "*/*" };
    const cookie = tracker.api.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const upstream = await fetch(parsed.toString(), {
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `asset upstream ${upstream.status}` });
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (error) {
    res.status(502).json({ error: error?.message || "falha no asset" });
  }
});

// Modo Cinema 3D (experimental): shell/scene, moveis e texturas.
app.get("/api/sala-3d/:roomId", async (req, res) => {
  const roomId = String(req.params.roomId || "").trim();
  if (!/^\d+-\d+$/.test(roomId)) {
    res.status(400).json({ error: "ID de sala invalido. Use o formato 123456-1." });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  try {
    const room = await tracker.api.room3d(roomId);
    if (!room) {
      res.status(404).json({ error: "sala 3D nao encontrada" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ok: true, room });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    extensions: ["html"],
    maxAge: "1h",
  })
);

const server = http.createServer(app);
// Sem timeout para o stream de rádio ficar aberto no IMVU.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.timeout = 0;
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024,
  clientTracking: true,
});

let nextClientId = 1;

wss.on("connection", (ws, req) => {
  const client = {
    id: nextClientId++,
    ws,
    alive: true,
    track: null,
    cinemaRooms: new Set(),
    watchGen: 0,
    lastWatchAt: 0,
    lastAlertAt: 0,
    ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""),
    send(payload) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    },
  };

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  log.info(`[ws] cliente ${client.id} conectado (${client.ip})`);
  client.send({
    type: "hello",
    service: "imvu-radar",
    version: VERSION,
    status: tracker.stats(),
    at: Date.now(),
  });

  ws.on("message", async (raw) => {
    if (raw.length > 8 * 1024) {
      client.send({ type: "error", code: "message_too_large", message: "Mensagem grande demais." });
      return;
    }
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      client.send({ type: "error", code: "bad_json", message: "JSON invalido." });
      return;
    }
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "watch": {
        const nick = safeNick(message.nick);
        if (!nick) {
          client.send({ type: "error", code: "invalid_nick", message: "Digite um nick valido." });
          return;
        }
        const current = tracker.stats();
        const alreadyWatching = client.track && client.track.nick === nick;
        if (!alreadyWatching && current.watchers >= MAX_WATCHERS) {
          client.send({
            type: "error",
            code: "capacity",
            message: "Servidor cheio de vigias agora. Tente em instantes.",
          });
          return;
        }
        const at = Date.now();
        if (at - client.lastWatchAt < 1_200) {
          client.send({ type: "error", code: "rate_limit", message: "Aguarde um instante antes de vigiar outro nick." });
          return;
        }
        client.lastWatchAt = at;
        try {
          await tracker.watch(client, nick);
        } catch (error) {
          log.error(`[ws] watch falhou: ${error?.stack || error}`);
          client.send({
            type: "error",
            code: "watch_failed",
            message: "Falha ao iniciar o rastreamento.",
          });
        }
        break;
      }
      case "alert_start": {
        const at = Date.now();
        if (at - client.lastAlertAt < 3_000) {
          client.send({ type: "alert_error", code: "rate_limit", message: "Aguarde um instante para alterar os alertas." });
          break;
        }
        client.lastAlertAt = at;
        try {
          const result = await tracker.startAlert(message);
          client.send({ type: "alert_active", ...result, at: Date.now() });
        } catch (error) {
          client.send({
            type: "alert_error",
            code: "alert_failed",
            message: error?.message || "Falha ao ativar os alertas.",
          });
        }
        break;
      }
      case "alert_stop":
        tracker.stopAlert(message);
        client.send({ type: "alert_stopped", at: Date.now() });
        break;
      case "alert_test":
        tracker.testAlert(message);
        break;
      case "cinema_join": {
        try {
          await cinema.join(client, message.roomId);
        } catch (error) {
          client.send({
            type: "cinema_error",
            roomId: String(message.roomId || ""),
            message: error?.message || "Falha ao iniciar o Modo Cinema.",
          });
        }
        break;
      }
      case "cinema_leave":
        cinema.leave(client, message.roomId);
        break;
      case "stop":
        tracker.unwatch(client);
        break;
      case "ping":
        client.send({ type: "pong", at: Date.now() });
        break;
      default:
        client.send({ type: "error", code: "unknown_type", message: "Tipo de mensagem desconhecido." });
        break;
    }
  });

  ws.on("close", () => {
    cinema.leaveAll(client);
    tracker.unwatch(client, { silent: true });
    log.info(`[ws] cliente ${client.id} desconectado`);
  });

  ws.on("error", (error) => {
    log.warn(`[ws] erro cliente ${client.id}: ${error?.message || error}`);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignora */
    }
  }
}, 30_000);

function shutdown(signal) {
  log.info(`[server] ${signal} recebido, encerrando...`);
  clearInterval(heartbeat);
  try {
    wss.close();
  } catch {
    /* ignora */
  }
  tracker.destroy();
  radioStream.shutdown();
  cinema.shutdown();
  telegram.stop();
  void musicBot.shutdown().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log.error(`[server] uncaughtException: ${error?.stack || error}`);
});
process.on("unhandledRejection", (error) => {
  log.error(`[server] unhandledRejection: ${error?.stack || error}`);
});

server.listen(PORT, () => {
  log.info(`[server] IMVU Radar backend v${VERSION} em http://localhost:${PORT}`);
  log.info(`[server] WebSocket no mesmo host/porta · max watchers ${MAX_WATCHERS}`);
  log.info(`[server] Telegram bot: ${telegram.enabled ? "ativo" : "desligado (sem token)"}`);
});

// Modo Cinema 3D: hotfix de overlay (deploy 2026-11-27).
