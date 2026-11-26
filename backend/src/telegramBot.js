import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, InputFile } from "node-telegram-bot-api";
import Database from "better-sqlite3";
import { safeNick } from "./imvu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "telegram.db");
const TOKEN_PLACEHOLDER = "COLE_O_TOKEN_AQUI";
const NO_PREVIEW = { is_disabled: true };

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const clip = (value, max = 64) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const normalizeImage = (value) => {
  const url = String(value || "").trim();
  if (!url) return "";
  return url.startsWith("//") ? `https:${url}` : url;
};

const MENU_TEXT = "🤖 <b>Radar IMVU VIP</b>\nEscolha uma opção abaixo:";

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "👀 Vigiar Alvo", callback_data: "menu:watch" },
      { text: "📍 Status do Alvo", callback_data: "menu:status" },
    ],
    [
      { text: "👕 Ver Fit", callback_data: "menu:fit" },
      { text: "❌ Parar Monitoramento", callback_data: "menu:stop" },
    ],
  ],
};

const COMMANDS = [
  { command: "start", description: "Abrir o menu de opções" },
  { command: "status", description: "Sala atual de um nick" },
  { command: "fit", description: "Avatar 2D de um nick" },
  { command: "parar", description: "Cancelar monitoramento" },
];

const DISABLED = {
  enabled: false,
  notifyRoomChange() {},
  stop() {},
  stats: () => ({ enabled: false, targets: 0, watching: 0 }),
};

/**
 * Bot do Telegram integrado ao RadarTracker.
 * - Comandos: /start, /status, /fit, /parar (com Inline Keyboards).
 * - Alvos persistidos em SQLite (telegram_alvos).
 * - Alertas em tempo real via tracker.onRoomChange (hook no setRoom).
 */
export function initTelegramBot({ tracker, log = console } = {}) {
  const token = String(process.env.TELEGRAM_TOKEN || "").trim();
  const disabledByFlag = ["1", "true", "yes", "on"].includes(
    String(process.env.TELEGRAM_DISABLED || "").trim().toLowerCase()
  );
  if (disabledByFlag || !token || token === TOKEN_PLACEHOLDER || !/^\d+:[\w-]{10,}$/.test(token)) {
    log.info(
      disabledByFlag
        ? "[telegram] bot desligado por TELEGRAM_DISABLED"
        : "[telegram] bot desligado (defina TELEGRAM_TOKEN no .env)"
    );
    return DISABLED;
  }
  if (!tracker) {
    log.warn("[telegram] tracker ausente; bot nao iniciado");
    return DISABLED;
  }

  const envInt = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  };
  // Limites para nao estourar o rate limit do IMVU com muitos alvos.
  const MAX_TARGETS = envInt("MAX_TELEGRAM_ALVOS", 30);
  const MAX_PER_CHAT = envInt("MAX_TELEGRAM_ALVOS_POR_CHAT", 3);

  // ---------------- banco ----------------
  let db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_alvos (
        chat_id TEXT NOT NULL,
        nick_alvo TEXT NOT NULL COLLATE NOCASE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, nick_alvo)
      );
    `);
  } catch (error) {
    log.error(`[telegram] falha ao abrir o SQLite: ${error?.message || error}`);
    try {
      db?.close();
    } catch {
      /* ignora */
    }
    return DISABLED;
  }

  const qSave = db.prepare(
    "INSERT OR IGNORE INTO telegram_alvos (chat_id, nick_alvo, created_at) VALUES (?, ?, ?)"
  );
  const qRemove = db.prepare("DELETE FROM telegram_alvos WHERE chat_id = ? AND nick_alvo = ?");
  const qList = db.prepare(
    "SELECT nick_alvo FROM telegram_alvos WHERE chat_id = ? ORDER BY created_at ASC"
  );
  const qChats = db.prepare("SELECT chat_id FROM telegram_alvos WHERE nick_alvo = ?");
  const qCountNick = db.prepare("SELECT COUNT(*) AS total FROM telegram_alvos WHERE nick_alvo = ?");
  const qDistinct = db.prepare("SELECT DISTINCT nick_alvo FROM telegram_alvos");
  const qCountAll = db.prepare("SELECT COUNT(*) AS total FROM telegram_alvos");

  const listTargets = (chatId) => qList.all(String(chatId)).map((row) => row.nick_alvo);
  const chatsForNick = (nick) => qChats.all(String(nick)).map((row) => String(row.chat_id));
  const countForNick = (nick) => Number(qCountNick.get(String(nick))?.total || 0);

  // ---------------- bot ----------------
  let bot;
  try {
    bot = new Bot(token);
  } catch (error) {
    log.error(`[telegram] falha ao iniciar o bot: ${error?.message || error}`);
    try {
      db.close();
    } catch {
      /* ignora */
    }
    return DISABLED;
  }

  let running = true;
  let lastPollErrorAt = 0;

  bot.catch((error) => {
    if (now() - lastPollErrorAt < 5_000) return;
    lastPollErrorAt = now();
    log.warn(`[telegram] handler falhou: ${error?.message || error}`);
  });

  // ---------------- estado ----------------
  const pending = new Map(); // chatId -> ação aguardando nick
  const watchers = new Map(); // nickLower -> client fake do tracker
  const watchInFlight = new Map(); // nickLower -> promise
  const lastActionAt = new Map();
  const lastAlertAt = new Map();

  const send = (chatId, text, extra = {}) =>
    bot.api
      .sendMessage({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: NO_PREVIEW,
        ...extra,
      })
      .catch((error) => {
        log.warn(`[telegram] sendMessage falhou (${chatId}): ${error?.message || error}`);
        return null;
      });

  async function editOrSend(chatId, sent, text) {
    if (sent?.message_id) {
      try {
        await bot.api.editMessageText({
          chat_id: chatId,
          message_id: sent.message_id,
          text,
          parse_mode: "HTML",
          link_preview_options: NO_PREVIEW,
        });
        return;
      } catch {
        /* cai para o envio simples */
      }
    }
    await send(chatId, text);
  }

  function allow(chatId, ms = 1_500) {
    const id = String(chatId);
    const previous = lastActionAt.get(id) || 0;
    if (now() - previous < ms) return false;
    lastActionAt.set(id, now());
    if (lastActionAt.size > 800) {
      const oldest = lastActionAt.keys().next().value;
      if (oldest) lastActionAt.delete(oldest);
    }
    return true;
  }

  // ---------------- watchers no tracker ----------------
  function makeWatchClient() {
    return {
      watchGen: 0,
      track: null,
      send() {
        /* sem websocket: mensagens de status do tracker sao ignoradas */
      },
    };
  }

  function watchNick(rawNick) {
    const nick = safeNick(rawNick);
    if (!nick) return Promise.resolve(null);
    const key = nick.toLowerCase();
    const existing = watchers.get(key);
    if (existing?.track) return Promise.resolve(existing);
    if (watchInFlight.has(key)) return watchInFlight.get(key);

    const promise = (async () => {
      const client = existing || makeWatchClient();
      watchers.set(key, client);
      try {
        await tracker.watch(client, nick);
      } catch (error) {
        log.warn(`[telegram] watch(${nick}) falhou: ${error?.message || error}`);
      }
      // O alvo foi removido do banco enquanto o watch subia.
      if (watchers.get(key) !== client) {
        try {
          tracker.unwatch(client);
        } catch {
          /* ignora */
        }
        return null;
      }
      if (!client.track) {
        watchers.delete(key);
        return null;
      }
      return client;
    })().finally(() => watchInFlight.delete(key));

    watchInFlight.set(key, promise);
    return promise;
  }

  function stopNick(rawNick) {
    const nick = safeNick(rawNick);
    if (!nick) return;
    const key = nick.toLowerCase();
    const client = watchers.get(key);
    watchers.delete(key);
    if (!client) return;
    try {
      tracker.unwatch(client);
    } catch (error) {
      log.warn(`[telegram] unwatch(${nick}) falhou: ${error?.message || error}`);
    }
  }

  // ---------------- consultas no IMVU ----------------
  async function lookup(rawNick) {
    const nick = safeNick(rawNick);
    if (!nick) return { error: "nick inválido" };
    const logged = await tracker.ensureLogin();
    if (!logged) return { error: tracker.api.lastError || "falha ao conectar no IMVU" };
    const profile = await tracker.api.resolve(nick).catch(() => null);
    if (!profile) return { error: `nick <b>${esc(nick)}</b> não encontrado no IMVU` };
    return { profile };
  }

  async function lookupRoom(profile) {
    const track = tracker.tracks.get(profile.cid);
    if (track?.room) {
      return { room: track.room, occupants: tracker.occupantList(track) };
    }

    const rid = await tracker.api.currentRoom(profile.cid, 0).catch(() => "");
    if (!rid) return { room: null, occupants: [] };

    const hint = { name: rid === `${profile.cid}-1` ? "My Room" : "" };
    const room =
      (await tracker.api.roomInfo(rid, hint).catch(() => null)) || { roomId: rid, name: hint.name };
    if (!room.name || room.name === rid) {
      room.name = hint.name || (room.privacy === "private" ? `Sala privada (ID: ${rid})` : `Sala ${rid}`);
    }

    const people = await tracker.api.roster(rid, 0).catch(() => []);
    const occupants = people.map((person) => ({
      cid: person.cid,
      username: person.username,
      displayName: person.displayName,
    }));
    if (!occupants.some((person) => String(person.cid) === String(profile.cid))) {
      occupants.unshift({
        cid: profile.cid,
        username: profile.username,
        displayName: profile.displayName,
      });
    }
    return { room, occupants };
  }

  function statusText(profile, room, occupants) {
    const nick = esc(profile.username || profile.displayName || profile.cid);
    if (!room?.roomId) {
      return `📍 O alvo <b>${nick}</b> não está em nenhuma sala agora (ou a localização está oculta).`;
    }
    const name = esc(
      room.name && room.name !== room.roomId ? room.name : `Sala ${room.roomId}`
    );
    const others = (occupants || []).filter(
      (person) => String(person.cid) !== String(profile.cid)
    );
    const names = others
      .map((person) => person.username || person.displayName || person.cid)
      .filter(Boolean);
    const total = (occupants || []).length;
    const companions = names.length ? clip(names.slice(0, 50).join(", "), 1_500) : "ninguém";
    const lines = [
      `📍 O alvo <b>${nick}</b> está na sala <b>${name}</b> (<code>${esc(room.roomId)}</code>).`,
      `👥 Junto com: ${esc(companions)} (Total: ${total} ${total === 1 ? "pessoa" : "pessoas"}).`,
    ];
    if (room.directLink) lines.push(`🔗 Link: ${esc(room.directLink)}`);
    return lines.join("\n");
  }

  function buildAlertText(track, occupants) {
    const room = track.room || {};
    const nick = esc(track.nick || track.profile?.username || "");
    const roomName = esc(
      room.name && room.name !== room.roomId ? room.name : `Sala ${room.roomId || ""}`
    );
    const others = (occupants || []).filter(
      (person) => String(person.cid) !== String(track.cid)
    );
    const names = others
      .map((person) => person.username || person.displayName || person.cid)
      .filter(Boolean);
    const total = Math.max((occupants || []).length, Number(room.occupancy) || 0);
    const companions = names.length ? clip(names.slice(0, 50).join(", "), 1_800) : "sozinho(a)";
    const link = room.directLink || (room.roomId ? `imvu://room/${room.roomId}` : "");
    return [
      "🚨 <b>ALERTA EM TEMPO REAL</b>",
      "",
      `O alvo <b>${nick}</b> entrou em uma sala!`,
      `📍 Sala: <b>${roomName}</b> (<code>${esc(room.roomId || "")}</code>)`,
      `👥 Acompanhantes: ${esc(companions)} (Total: ${total} ${total === 1 ? "pessoa" : "pessoas"})`,
      `🔗 Link: ${esc(link)}`,
    ].join("\n");
  }

  // ---------------- fluxos ----------------
  async function prompt(chatId, action, text) {
    pending.set(String(chatId), action);
    await send(chatId, text);
  }

  function defaultTarget(chatId) {
    const targets = listTargets(chatId);
    return targets.length === 1 ? targets[0] : "";
  }

  async function runWatch(chatId, rawNick) {
    if (!allow(chatId, 2_000)) return;
    const sent = await send(chatId, `🔎 Procurando <b>${esc(rawNick)}</b> no IMVU...`);
    const found = await lookup(rawNick);
    if (found.error) {
      await editOrSend(chatId, sent, `⚠️ ${found.error}`);
      return;
    }

    const nick = found.profile.username || rawNick;

    const meus = listTargets(chatId).map((value) => String(value).toLowerCase());
    if (!meus.includes(nick.toLowerCase()) && meus.length >= MAX_PER_CHAT) {
      await editOrSend(
        chatId,
        sent,
        `⚠️ Limite de ${MAX_PER_CHAT} alvos por pessoa. Use /parar para liberar espaço.`
      );
      return;
    }
    const globais = qDistinct.all().map((row) => String(row.nick_alvo).toLowerCase());
    if (!globais.includes(nick.toLowerCase()) && globais.length >= MAX_TARGETS) {
      await editOrSend(
        chatId,
        sent,
        "⚠️ O radar atingiu o limite de alvos monitorados agora. Tente de novo em instantes."
      );
      return;
    }

    qSave.run(String(chatId), nick, now());
    const client = await watchNick(nick);
    const track = client?.track;

    let extra = "";
    if (track?.room) {
      extra = `\n📍 Sala atual: <b>${esc(track.room.name || `Sala ${track.room.roomId}`)}</b> (<code>${esc(
        track.room.roomId
      )}</code>).`;
    }
    await editOrSend(
      chatId,
      sent,
      `✅ Alvo <b>${esc(nick)}</b> ativado! Vou te avisar aqui quando ele mudar de sala.${extra}`
    );
  }

  async function runStatus(chatId, rawNick) {
    if (!allow(chatId)) return;
    const sent = await send(chatId, "🔎 Consultando o IMVU...");
    const found = await lookup(rawNick);
    if (found.error) {
      await editOrSend(chatId, sent, `⚠️ ${found.error}`);
      return;
    }
    const { room, occupants } = await lookupRoom(found.profile);
    await editOrSend(chatId, sent, statusText(found.profile, room, occupants));
  }

  async function sendFit(chatId, profile) {
    const urls = [
      ...new Set(
        [normalizeImage(profile.render), normalizeImage(profile.avatar), normalizeImage(profile.portrait)].filter(
          Boolean
        )
      ),
    ];
    if (!urls.length) {
      await send(chatId, `👕 Não achei a imagem do avatar de <b>${esc(profile.username)}</b>.`);
      return;
    }

    for (const url of urls) {
      const image = await tracker.api.fetchImage(url).catch(() => null);
      if (!image?.buffer?.length) continue;
      try {
        await bot.api.sendPhoto({
          chat_id: chatId,
          photo: new InputFile(image.buffer, {
            filename: "fit.png",
            contentType: image.contentType || "image/png",
          }),
          caption: `👕 Fit de <b>${esc(profile.username)}</b>`,
          parse_mode: "HTML",
        });
        return;
      } catch (error) {
        log.warn(`[telegram] sendPhoto falhou: ${error?.message || error}`);
      }
    }
    await send(chatId, `👕 Não consegui enviar a imagem de <b>${esc(profile.username)}</b> agora.`);
  }

  async function runFit(chatId, rawNick) {
    if (!allow(chatId)) return;
    const sent = await send(chatId, "🔎 Buscando o fit...");
    const found = await lookup(rawNick);
    if (found.error) {
      await editOrSend(chatId, sent, `⚠️ ${found.error}`);
      return;
    }
    if (sent?.message_id) {
      try {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: sent.message_id });
      } catch {
        /* ignora */
      }
    }
    await sendFit(chatId, found.profile);
  }

  async function runStop(chatId, rawNick) {
    if (!allow(chatId)) return;
    const nick = safeNick(rawNick);
    if (!nick) return;
    qRemove.run(String(chatId), nick);
    if (countForNick(nick) === 0) stopNick(nick);
    await send(chatId, `🚫 Monitoramento de <b>${esc(nick)}</b> cancelado.`);
  }

  async function sendStopPicker(chatId, targets) {
    const keyboard = {
      inline_keyboard: targets.slice(0, 20).map((nick, index) => [
        { text: `❌ ${clip(nick, 40)}`, callback_data: `pick:stop:${index}` },
      ]),
    };
    await send(chatId, "Escolha qual alvo deseja parar de monitorar:", {
      reply_markup: keyboard,
    });
  }

  async function pickOrPrompt(chatId, action, promptText) {
    const targets = listTargets(chatId);
    if (targets.length === 1) {
      if (action === "status") return runStatus(chatId, targets[0]);
      if (action === "fit") return runFit(chatId, targets[0]);
      if (action === "stop") return runStop(chatId, targets[0]);
    }
    if (targets.length > 1) {
      const keyboard = {
        inline_keyboard: targets.slice(0, 20).map((nick, index) => [
          { text: `👤 ${clip(nick, 40)}`, callback_data: `pick:${action}:${index}` },
        ]),
      };
      await send(chatId, "Escolha o alvo:", { reply_markup: keyboard });
      return;
    }
    await prompt(chatId, action, promptText);
  }

  // ---------------- comandos ----------------
  bot.command("start", async (ctx) => {
    if (!ctx.chatId) return;
    await send(ctx.chatId, MENU_TEXT, { reply_markup: MENU_KEYBOARD });
  });

  bot.command("menu", async (ctx) => {
    if (!ctx.chatId) return;
    await send(ctx.chatId, MENU_TEXT, { reply_markup: MENU_KEYBOARD });
  });

  bot.command("status", async (ctx) => {
    if (!ctx.chatId) return;
    const arg = typeof ctx.match === "string" ? ctx.match : "";
    const nick = safeNick(arg) || defaultTarget(ctx.chatId);
    if (!nick) {
      await prompt(ctx.chatId, "status", "Digite o nick para consultar a sala atual:");
      return;
    }
    await runStatus(ctx.chatId, nick);
  });

  bot.command("fit", async (ctx) => {
    if (!ctx.chatId) return;
    const arg = typeof ctx.match === "string" ? ctx.match : "";
    const nick = safeNick(arg) || defaultTarget(ctx.chatId);
    if (!nick) {
      await prompt(ctx.chatId, "fit", "Digite o nick para ver o fit:");
      return;
    }
    await runFit(ctx.chatId, nick);
  });

  bot.command("parar", async (ctx) => {
    if (!ctx.chatId) return;
    const chatId = ctx.chatId;
    const arg = typeof ctx.match === "string" ? ctx.match : "";
    const nick = safeNick(arg) || defaultTarget(chatId);
    if (nick) {
      await runStop(chatId, nick);
      return;
    }
    const targets = listTargets(chatId);
    if (!targets.length) {
      await send(chatId, "Você não tem alvos monitorados. Use 👀 <b>Vigiar Alvo</b> no menu.");
      return;
    }
    await sendStopPicker(chatId, targets);
  });

  bot.on("callback_query", async (ctx) => {
    try {
      const chatId = ctx.chatId;
      const data = String(ctx.callbackQuery?.data || "");
      await ctx.answerCallbackQuery({}).catch(() => {});
      if (!chatId) return;

      if (data === "menu:watch") {
        await prompt(chatId, "watch", "Digite o nick que deseja vigiar:");
        return;
      }
      if (data === "menu:status") {
        await pickOrPrompt(chatId, "status", "Digite o nick para consultar a sala atual:");
        return;
      }
      if (data === "menu:fit") {
        await pickOrPrompt(chatId, "fit", "Digite o nick para ver o fit:");
        return;
      }
      if (data === "menu:stop") {
        const targets = listTargets(chatId);
        if (!targets.length) {
          await send(chatId, "Você não tem alvos monitorados.");
          return;
        }
        await sendStopPicker(chatId, targets);
        return;
      }

      const picked = /^pick:(\w+):(\d+)$/.exec(data);
      if (picked) {
        const action = picked[1];
        const index = Number(picked[2]);
        const nick = listTargets(chatId)[index];
        if (!nick) {
          await send(chatId, "Essa opção expirou. Manda o comando de novo.");
          return;
        }
        if (action === "status") await runStatus(chatId, nick);
        else if (action === "fit") await runFit(chatId, nick);
        else if (action === "stop") await runStop(chatId, nick);
      }
    } catch (error) {
      log.warn(`[telegram] callback falhou: ${error?.message || error}`);
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const chatId = ctx.chatId;
      const text = String(ctx.message?.text || "").trim();
      if (!chatId || !text || text.startsWith("/")) return;
      const action = pending.get(String(chatId));
      if (!action) return;
      pending.delete(String(chatId));
      const nick = safeNick(text);
      if (!nick) {
        await send(chatId, "⚠️ Nick inválido. Tente de novo.");
        return;
      }
      if (action === "watch") await runWatch(chatId, nick);
      else if (action === "status") await runStatus(chatId, nick);
      else if (action === "fit") await runFit(chatId, nick);
    } catch (error) {
      log.warn(`[telegram] mensagem falhou: ${error?.message || error}`);
    }
  });

  // ---------------- alertas em tempo real ----------------
  async function notifyRoomChange(track, previousRoom = null) {
    try {
      if (!track?.room?.roomId) return;
      // Primeira leitura logo apos criar o track nao e uma "mudanca" de sala.
      if (!previousRoom && now() - (track.createdAt || 0) < 90_000) return;

      const nicks = [...new Set([track.nick, track.profile?.username].filter(Boolean))];
      const chats = new Set();
      for (const nick of nicks) {
        for (const chatId of chatsForNick(nick)) chats.add(chatId);
      }
      if (!chats.size) return;

      const roomId = track.room.roomId;
      const occupants =
        typeof track.occupantList === "function" ? track.occupantList() : [];
      const text = buildAlertText(track, occupants);

      for (const chatId of chats) {
        const key = `${chatId}:${track.cid}:${roomId}`;
        if (now() - (lastAlertAt.get(key) || 0) < 30_000) continue;
        lastAlertAt.set(key, now());
        if (lastAlertAt.size > 500) {
          const oldest = lastAlertAt.keys().next().value;
          if (oldest) lastAlertAt.delete(oldest);
        }

        bot.api
          .sendMessage({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            link_preview_options: NO_PREVIEW,
          })
          .catch((error) => {
            const blocked =
              error?.errorCode === 403 && /blocked|chat not found|deactivated/i.test(String(error?.description || ""));
            if (blocked) {
              for (const nick of nicks) qRemove.run(String(chatId), nick);
              log.info(`[telegram] chat ${chatId} bloqueou o bot; alvos removidos`);
            } else {
              log.warn(`[telegram] alerta falhou (${chatId}): ${error?.message || error}`);
            }
          });
      }
    } catch (error) {
      log.warn(`[telegram] notify falhou: ${error?.message || error}`);
    }
  }

  // ---------------- restauracao de alvos ----------------
  async function restoreWatches() {
    const nicks = qDistinct.all().map((row) => row.nick_alvo);
    if (!nicks.length) return;
    log.info(`[telegram] restaurando ${nicks.length} alvo(s) do banco...`);
    for (const nick of nicks) {
      if (!running) return;
      await watchNick(nick);
      await sleep(2_500);
    }
  }

  const retryTimer = setInterval(() => {
    if (!running) return;
    const nicks = qDistinct.all().map((row) => row.nick_alvo);
    for (const nick of nicks) {
      if (watchers.get(nick.toLowerCase())?.track) continue;
      watchNick(nick).catch(() => {});
    }
  }, 10 * 60_000);
  retryTimer.unref?.();

  const restoreTimer = setTimeout(() => {
    if (running) void restoreWatches();
  }, 5_000);
  restoreTimer.unref?.();

  // ---------------- start/stop ----------------
  bot.api.setMyCommands({ commands: COMMANDS }).catch(() => {});

  void bot
    .startPolling(undefined, { timeout: 30, retry: true })
    .catch((error) => log.error(`[telegram] polling encerrou: ${error?.message || error}`));

  function stop() {
    running = false;
    clearInterval(retryTimer);
    clearTimeout(restoreTimer);
    try {
      bot.stop();
    } catch {
      /* ignora */
    }
    try {
      db.close();
    } catch {
      /* ignora */
    }
  }

  function stats() {
    return {
      enabled: true,
      targets: Number(qCountAll.get()?.total || 0),
      watching: [...watchers.values()].filter((client) => client.track).length,
    };
  }

  log.info("[telegram] bot iniciado (polling)");
  return { enabled: true, notifyRoomChange, stop, stats };
}
