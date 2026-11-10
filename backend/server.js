import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocket, WebSocketServer } from "ws";
import { RadarTracker } from "./src/tracker.js";
import { safeNick } from "./src/imvu.js";
import { findRooms as catvuFind } from "./src/catvu.js";

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
    ...tracker.stats(),
    now: Date.now(),
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

app.get("/api/diag", async (req, res) => {
  const nick = safeNick(req.query.nick || "xProf");
  if (!nick) {
    res.status(400).json({ error: "nick obrigatorio" });
    return;
  }
  const logged = await tracker.ensureLogin();
  if (!logged) {
    res.status(503).json({ error: tracker.api.lastError || "login falhou" });
    return;
  }
  const person = await tracker.api.resolve(nick);
  if (!person) {
    res.status(404).json({ error: "nick nao encontrado" });
    return;
  }
  const cid = person.cid;
  const catvu = await catvuFind(nick, { timeout: 12_000, force: true });
  let catvuRaw = null;
  try {
    const rawResponse = await fetch(
      `https://catvu.live/api/private-room/find?username=${encodeURIComponent(nick)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12_000),
      }
    );
    catvuRaw = {
      status: rawResponse.status,
      body: String(await rawResponse.text()).slice(0, 800),
    };
  } catch (error) {
    catvuRaw = { error: String(error?.message || error) };
  }
  const paths = [
    `/api/avatarcard.php?cid=${cid}`,
    `/api/users/get_user_current_room.php?cid=${cid}`,
    `/api/rooms/user_current_room.php?cid=${cid}`,
    `/api/rooms/current_room.php?cid=${cid}`,
    `/api/users/user_location.php?cid=${cid}`,
    `/api/rooms/room_of_user.php?cid=${cid}`,
    `/api/rooms/room_info.php?room_id=${cid}-1`,
  ];
  const calls = {};
  for (const path of paths) {
    const result = await tracker.api.clientDynamic(path);
    const limit = path.includes("avatarcard") ? 20_000 : 1_200;
    calls[path] = { status: result.status, body: String(result.text || "").slice(0, limit) };
  }
  res.json({ nick, cid, profile: person, catvu, catvuRaw, calls });
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

app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    extensions: ["html"],
    maxAge: "1h",
  })
);

const server = http.createServer(app);
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
    watchGen: 0,
    lastWatchAt: 0,
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
});
