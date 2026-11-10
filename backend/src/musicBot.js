import "dotenv/config";
import { Client } from "@imvu/client";

/**
 * Music Bot / Radio para salas do IMVU.
 *
 * O login, a entrada na sala e o chat usam @imvu/client, que por sua vez
 * usa @imvu/imq para o canal realtime (mensagens e keepalive da sala).
 *
 * Regras de seguranca:
 *  - a conta do bot deve ser SEPARADA da conta do rastreador (IMVU_USER);
 *  - toda mensagem passa por uma fila com intervalo minimo de 1500 ms;
 *  - o bot so responde a !play, !skip e !stop no chat publico da sala.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? "").trim();

const PLACEHOLDERS = new Set([
  "seu_email_do_bot@gmail.com",
  "sua_senha_do_bot",
  "nome_do_bot",
]);

const isPlaceholder = (value) => {
  const normalized = clean(value).toLowerCase();
  return !normalized || PLACEHOLDERS.has(normalized);
};

const MIN_SEND_INTERVAL_MS = Math.max(
  1_500,
  Number(process.env.BOT_SEND_INTERVAL_MS) || 1_500
);
const COMMAND_COOLDOWN_MS = 2_500;
const MAX_PENDING_MESSAGES = 12;

/** Lista de radios publicas. Para trocar, edite name/url abaixo. */
export const RADIOS = [
  {
    name: "Zeno FM",
    url: "http://stream.zeno.fm/0r0xa792kwzuv",
  },
  {
    name: "SomaFM Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
  },
  {
    name: "SomaFM Lush",
    url: "https://ice1.somafm.com/lush-128-mp3",
  },
  {
    name: "SomaFM Deep Space One",
    url: "https://ice1.somafm.com/deepspaceone-128-mp3",
  },
];

class MusicBot {
  constructor() {
    this.client = null;
    this.session = null;
    this.loginPromise = null;
    this.joining = false;
    this.connected = false;
    this.roomId = "";
    this.roomName = "";
    this.joinedAt = 0;
    this.radioIndex = 0;
    this.lastError = "";
    this.lastSentAt = 0;
    this.sendChain = Promise.resolve();
    this.pendingSends = 0;
    this.commandCooldowns = new Map();
    this.stopping = false;
    this.username = "";
  }

  credentials() {
    const username = clean(process.env.BOT_USERNAME);
    const email = clean(process.env.BOT_EMAIL);
    const password = clean(process.env.BOT_PASSWORD);
    const validUsername = !isPlaceholder(username) ? username : "";
    const validEmail = !isPlaceholder(email) ? email : "";
    const validPassword = !isPlaceholder(password) ? password : "";

    return {
      username: validUsername,
      email: validEmail,
      password: validPassword,
      configured: Boolean(validPassword && (validUsername || validEmail)),
    };
  }

  currentRadio() {
    return RADIOS[this.radioIndex % RADIOS.length];
  }

  async ensureClient() {
    if (this.client?.authenticated) return this.client;
    if (this.loginPromise) return this.loginPromise;

    const credentials = this.credentials();
    if (!credentials.configured) {
      throw new Error(
        "Bot nao configurado. Preencha BOT_USERNAME (ou BOT_EMAIL) e BOT_PASSWORD no backend/.env."
      );
    }

    const trackerUser = clean(process.env.IMVU_USER);
    if (
      !process.env.BOT_ALLOW_SAME_ACCOUNT &&
      credentials.username &&
      trackerUser &&
      credentials.username.toLowerCase() === trackerUser.toLowerCase()
    ) {
      throw new Error(
        "A conta do bot e a mesma do rastreador (IMVU_USER). Use uma conta separada para o bot ou defina BOT_ALLOW_SAME_ACCOUNT=1."
      );
    }

    const candidates = [...new Set([credentials.username, credentials.email].filter(Boolean))];
    this.loginPromise = (async () => {
      let lastError = null;
      for (const loginName of candidates) {
        const client = new Client();
        try {
          await client.login(loginName, credentials.password);
          this.client = client;
          this.username = loginName;
          this.lastError = "";
          console.log(`[bot] login ok (${loginName})`);
          return client;
        } catch (error) {
          lastError = error;
          console.warn(`[bot] login falhou (${loginName}): ${error?.message || error}`);
          try {
            await client.logout();
          } catch {
            /* ignora */
          }
        }
      }
      this.lastError = "Login do bot falhou. Confira BOT_USERNAME/BOT_EMAIL e BOT_PASSWORD.";
      throw new Error(`${this.lastError}${lastError?.message ? ` (${lastError.message})` : ""}`);
    })().finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  async join(roomId) {
    const id = clean(roomId);
    if (!/^\d+-\d+$/.test(id)) {
      throw new Error("ID de sala invalido. Use o formato 123456-1.");
    }
    if (this.joining) {
      throw new Error("O bot ja esta entrando em uma sala. Aguarde.");
    }

    this.joining = true;
    this.lastError = "";
    try {
      if (this.session) await this.leave({ logout: false });

      const client = await this.ensureClient();
      const room = await client.rooms.fetch(id, { force: true });
      if (!room) throw new Error("Sala nao encontrada.");

      const chat = await room.chat();
      if (!chat) throw new Error("Essa sala nao tem chat classico para o bot entrar.");

      // Compatibilidade com a API atual: o @imvu/client manda POST {} em
      // /chat/chat-<rid>/participants, mas o IMVU exige o id do usuario.
      // Mantemos o client/realtime do library e so ajustamos esse POST.
      const originalRequest = client.request;
      client.request = function patchedRequest(url, options = {}) {
        const method = String(options.method || "GET").toUpperCase();
        const cleanUrl = String(url).split("?")[0].replace(/\/+$/, "");
        const data = options.data;
        const emptyData =
          !data ||
          (typeof data === "object" &&
            !Array.isArray(data) &&
            Object.keys(data).length === 0);
        if (method === "POST" && cleanUrl.endsWith("/participants") && emptyData) {
          return originalRequest.call(client, url, {
            ...options,
            data: { id: `https://api.imvu.com/user/user-${client.rest.cid}` },
          });
        }
        return originalRequest.call(client, url, options);
      };

      let session;
      try {
        session = await room.join({
          observeParticipants: false,
          ignoreOwnMessages: true,
          leaveWhenBooted: true,
          keepAliveInterval: 45_000,
        });
      } finally {
        delete client.request;
      }

      this.session = session;
      this.connected = true;
      this.roomId = id;
      this.roomName = room.name || id;
      this.joinedAt = Date.now();
      this.radioIndex = 0;
      this.stopping = false;
      this.lastSentAt = Date.now();
      this.commandCooldowns.clear();

      session.on("message", (message) => this.onMessage(message));
      session.on("close", (event) => this.onSessionClose(session, event));
      session.on("error", (error) => {
        this.lastError = error?.message || String(error);
        console.warn(`[bot] erro no chat: ${this.lastError}`);
      });

      console.log(`[bot] entrou na sala ${id} (${this.roomName})`);
      this.sendChat("🎧 DJ Bot conectado! Digite !play, !skip ou !stop no chat.").catch(() => {});
      return this.status();
    } catch (error) {
      const apiCode = String(error?.apiCode || error?.response?.error || "");
      if (apiCode === "CHAT_PARTICIPANT-011") {
        this.lastError =
          "O IMVU recusou a entrada (CHAT_PARTICIPANT-011). Use uma conta registrada (não Guest) e uma sala que permita o bot.";
        throw new Error(this.lastError);
      }
      this.lastError = error?.message || String(error);
      throw error;
    } finally {
      this.joining = false;
    }
  }

  async leave({ logout = false } = {}) {
    const session = this.session;
    const previousRoom = this.roomId;
    this.session = null;
    this.connected = false;
    this.roomId = "";
    this.roomName = "";
    this.joinedAt = 0;
    this.stopping = false;

    if (session) {
      try {
        await session.leave();
      } catch (error) {
        this.lastError = error?.message || String(error);
      }
    }

    if (logout && this.client) {
      try {
        await this.client.logout();
      } catch (error) {
        console.warn(`[bot] logout falhou: ${error?.message || error}`);
      }
      this.client = null;
      this.username = "";
    }

    if (previousRoom) console.log(`[bot] saiu da sala ${previousRoom}`);
    return this.status();
  }

  shutdown() {
    return this.leave({ logout: true });
  }

  onSessionClose(session, event) {
    if (this.session !== session) return;
    this.session = null;
    this.connected = false;
    this.roomId = "";
    this.roomName = "";
    this.joinedAt = 0;
    this.stopping = false;
    if (event?.reason === "booted") this.lastError = "O bot foi expulso da sala.";
    else if (event?.reason === "removed") this.lastError = "O bot foi removido da sala.";
    console.log(`[bot] chat fechado (${event?.reason || "desconhecido"})`);
  }

  onMessage(message) {
    if (!message || message.whisper || message.action) return;
    const text = clean(message.text).toLowerCase();
    const command = text.split(/\s+/)[0];
    if (!["!play", "!skip", "!stop"].includes(command)) return;

    const userId = String(message.userId || "");
    const now = Date.now();
    const last = this.commandCooldowns.get(userId) || 0;
    if (now - last < COMMAND_COOLDOWN_MS) return;
    this.commandCooldowns.set(userId, now);
    if (this.commandCooldowns.size > 300) {
      const oldest = this.commandCooldowns.keys().next().value;
      if (oldest) this.commandCooldowns.delete(oldest);
    }

    this.handleCommand(command, userId).catch((error) => {
      this.lastError = error?.message || String(error);
      console.warn(`[bot] comando ${command} falhou: ${this.lastError}`);
    });
  }

  async handleCommand(command, userId) {
    if (this.stopping) return;
    console.log(`[bot] comando ${command} de ${userId || "?"}`);

    if (command === "!play") {
      const radio = this.currentRadio();
      await this.sendChat(`🎵 Tocando agora: ${radio.name}\n${radio.url}`);
      return;
    }

    if (command === "!skip") {
      this.radioIndex = (this.radioIndex + 1) % RADIOS.length;
      const radio = this.currentRadio();
      await this.sendChat(`⏭️ Próxima rádio: ${radio.name}\n${radio.url}`);
      return;
    }

    if (command === "!stop") {
      this.stopping = true;
      await this.sendChat("⏹️ Rádio parada. Até mais!");
      await this.leave({ logout: false });
    }
  }

  /**
   * Fila anti-ban: nenhuma mensagem sai antes de 1500 ms da anterior.
   * O intervalo e medido depois do ACK do servidor.
   */
  sendChat(text) {
    const message = clean(text);
    if (!message) return Promise.resolve(false);
    if (!this.session || this.session.closed) return Promise.resolve(false);
    if (this.pendingSends >= MAX_PENDING_MESSAGES) {
      console.warn("[bot] fila de mensagens cheia; mensagem descartada");
      return Promise.resolve(false);
    }

    this.pendingSends += 1;
    this.sendChain = this.sendChain.then(async () => {
      try {
        const wait = Math.max(
          0,
          MIN_SEND_INTERVAL_MS - (Date.now() - this.lastSentAt)
        );
        if (wait > 0) await sleep(wait);
        if (!this.session || this.session.closed) return;
        await this.session.send(message);
        this.lastSentAt = Date.now();
      } catch (error) {
        this.lastError = `Falha ao enviar no chat: ${error?.message || error}`;
        console.warn(`[bot] ${this.lastError}`);
      } finally {
        this.pendingSends = Math.max(0, this.pendingSends - 1);
      }
    });

    return this.sendChain.then(() => true);
  }

  status() {
    const credentials = this.credentials();
    const radio = this.currentRadio();
    const sameAsTracker =
      credentials.username &&
      clean(process.env.IMVU_USER) &&
      credentials.username.toLowerCase() === clean(process.env.IMVU_USER).toLowerCase();
    const warning = sameAsTracker
      ? process.env.BOT_ALLOW_SAME_ACCOUNT
        ? "O bot compartilha a conta do rastreador; os dois usam a mesma conta IMVU."
        : "A conta do bot e a mesma do rastreador. Use uma conta separada."
      : "";

    return {
      configured: credentials.configured,
      loggedIn: Boolean(this.client?.authenticated),
      joining: this.joining,
      connected: Boolean(this.connected && this.session && !this.session.closed),
      roomId: this.roomId,
      roomName: this.roomName,
      joinedAt: this.joinedAt,
      radio: radio?.name || "",
      radioUrl: radio?.url || "",
      radios: RADIOS.map(({ name, url }) => ({ name, url })),
      sendIntervalMs: MIN_SEND_INTERVAL_MS,
      pendingMessages: this.pendingSends,
      warning,
      lastError: this.lastError,
    };
  }
}

export const musicBot = new MusicBot();
