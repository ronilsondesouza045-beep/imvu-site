import "dotenv/config";
import crypto from "node:crypto";
import { Client } from "@imvu/client";
import { radioStream } from "./radioStream.js";
import { searchSong } from "./songResolver.js";

/**
 * Music bot: fila por sala, busca qualquer música no YouTube e tenta trocar o
 * media_player da sala (provider web_radio). O IMVU exige que a conta seja
 * Host/Admin da sala; se a troca não for confirmada, o bot manda o link do
 * stream MP3 no chat para o usuário colar manualmente no rádio.
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
const MAX_QUEUE = 30;
const ADMIN_WARNING =
  "⚠️ Preciso ser Admin da sala para tocar a música automaticamente. Me dê Admin ou copie este link no rádio:";

const mediaPlayerSong = (song) =>
  song
    ? {
        title: song.title,
        url: song.url,
        durationSec: song.durationSec || 0,
        thumbnail: song.thumbnail || "",
      }
    : null;

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
    this.lastError = "";
    this.lastSentAt = 0;
    this.sendChain = Promise.resolve();
    this.playChain = Promise.resolve();
    this.pendingSends = 0;
    this.commandCooldowns = new Map();
    this.username = "";
    this.streamUrl = "";
    this.streamSession = "";
    this.mediaPlayerUrl = "";
    this.radioWarning = "";

    radioStream.on("streamError", (roomId, message) => {
      if (roomId !== this.roomId || !this.connected) return;
      this.lastError = message;
      this.sendChat(`❌ Não consegui tocar essa música: ${message}`).catch(() => {});
    });
    radioStream.on("idle", (roomId) => {
      if (roomId !== this.roomId || !this.connected) return;
      this.sendChat("⏹️ A fila terminou.").catch(() => {});
    });
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
      this.streamUrl = "";
      this.streamSession = "";
      this.mediaPlayerUrl = "";
      this.radioWarning = "";
      this.playChain = Promise.resolve();
      this.lastSentAt = Date.now();
      this.commandCooldowns.clear();

      session.on("message", (message) => this.onMessage(message));
      session.on("close", (event) => this.onSessionClose(session, event));
      session.on("error", (error) => {
        this.lastError = error?.message || String(error);
        console.warn(`[bot] erro no chat: ${this.lastError}`);
      });

      console.log(`[bot] entrou na sala ${id} (${this.roomName})`);
      this.sendChat(
        "🎧 DJ Bot conectado! Peça qualquer música: !play nome-da-musica · !skip · !stop. Preciso ser Admin da sala para tocar automaticamente."
      ).catch(() => {});
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
    this.streamUrl = "";
    this.streamSession = "";
    this.mediaPlayerUrl = "";
    this.radioWarning = "";

    if (previousRoom) radioStream.stop(previousRoom);

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

    this.lastError = "";
    if (previousRoom) console.log(`[bot] saiu da sala ${previousRoom}`);
    return this.status();
  }

  shutdown() {
    if (this.roomId) radioStream.stop(this.roomId);
    return this.leave({ logout: true });
  }

  onSessionClose(session, event) {
    if (this.session !== session) return;
    this.session = null;
    this.connected = false;
    const previousRoom = this.roomId;
    this.roomId = "";
    this.roomName = "";
    this.joinedAt = 0;
    this.streamUrl = "";
    this.streamSession = "";
    this.mediaPlayerUrl = "";
    if (previousRoom) radioStream.stop(previousRoom);
    if (event?.reason === "booted") this.lastError = "O bot foi expulso da sala.";
    else if (event?.reason === "removed") this.lastError = "O bot foi removido da sala.";
    console.log(`[bot] chat fechado (${event?.reason || "desconhecido"})`);
  }

  onMessage(message) {
    if (!message || message.whisper || message.action) return;
    const text = clean(message.text);
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = String(rawCommand || "").toLowerCase();
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

    this.handleCommand(command, args.join(" ").trim()).catch((error) => {
      this.lastError = error?.message || String(error);
      console.warn(`[bot] comando ${command} falhou: ${this.lastError}`);
    });
  }

  async handleCommand(command, argText) {
    if (!this.connected) return;
    console.log(`[bot] comando ${command}${argText ? ` (${argText.slice(0, 80)})` : ""}`);

    if (command === "!play") {
      await this.enqueuePlay(argText, { source: "chat" });
      return;
    }

    if (command === "!skip") {
      const result = radioStream.skip(this.roomId);
      if (!result.previous && !result.next) {
        await this.sendChat("⏭️ A fila está vazia.");
        return;
      }
      if (result.next) {
        await this.sendChat(`⏭️ Pulando... Próxima: ${result.next.title}`);
      } else {
        this.streamUrl = "";
        await this.tocarNaSala(this.roomId, "", "stopped", "").catch(() => {});
        await this.sendChat("⏭️ Essa era a última. A fila está vazia.");
      }
      return;
    }

    if (command === "!stop") {
      radioStream.stop(this.roomId);
      this.streamUrl = "";
      this.streamSession = "";
      await this.sendChat("⏹️ Fila limpa e música parada.");
      await this.tocarNaSala(this.roomId, "", "stopped", "").catch((error) => {
        console.warn(`[bot] não consegui parar o player da sala: ${error?.message || error}`);
      });
    }
  }

  /** Serializa buscas para a ordem da fila ser a ordem dos pedidos. */
  enqueuePlay(query, meta = {}) {
    const run = this.playChain.then(() => this.doPlay(query, meta));
    this.playChain = run.catch(() => {});
    return run;
  }

  async doPlay(query, meta = {}) {
    const text = clean(query);
    if (!text) {
      await this.sendChat("Use: !play nome-da-musica (ex.: !play Michael Jackson - Billie Jean)");
      return { ok: false, error: "Música não informada." };
    }

    if (radioStream.queueLength(this.roomId) >= MAX_QUEUE) {
      await this.sendChat(`⚠️ A fila está cheia (${MAX_QUEUE} músicas).`);
      return { ok: false, error: "Fila cheia." };
    }

    await this.sendChat(`🔎 Buscando: ${text}`);

    let song;
    try {
      song = await searchSong(text);
    } catch (error) {
      const message = error?.message || String(error);
      this.lastError = message;
      await this.sendChat(`❌ Não encontrei "${text}". Tente outro nome ou link do YouTube.`);
      throw error;
    }

    const wasEmpty =
      radioStream.queueLength(this.roomId) === 0 && !radioStream.currentSong(this.roomId);

    radioStream.enqueue(this.roomId, song);
    await this.sendChat(`🎵 Adicionado à fila: ${song.title}`);

    let streamUrl = this.streamUrl;
    let warning = this.radioWarning;

    if (wasEmpty) {
      this.streamSession = crypto.randomUUID();
      streamUrl = radioStream.urlForRoom(this.roomId, this.streamSession);
      try {
        await this.tocarNaSala(this.roomId, streamUrl, "playing", "DJ Bot");
        this.streamUrl = streamUrl;
        this.radioWarning = "";
        warning = "";
        await this.sendChat(`▶️ Tocando agora: ${song.title}`);
      } catch (error) {
        // O stream já está válido mesmo sem Admin; guardamos o link para o
        // usuário copiar no rádio da sala.
        this.streamUrl = streamUrl;
        this.radioWarning = error?.message || String(error);
        warning = this.radioWarning;
        this.lastError = this.radioWarning;
        await this.sendChat(`${ADMIN_WARNING} ${streamUrl}`);
      }
    } else if (!this.streamUrl) {
      // A fila já existia, mas o player ainda não tinha sido configurado.
      streamUrl = radioStream.urlForRoom(this.roomId);
    }

    return {
      ok: true,
      song: mediaPlayerSong(song),
      queue: radioStream.snapshot(this.roomId).queue,
      streamUrl: this.streamUrl || streamUrl,
      warning,
      source: meta.source || "chat",
    };
  }

  /**
   * Atualiza o media_player web_radio da sala. O IMVU expõe
   * media_player.current_state.station_url/status; a troca é feita por IMQ e
   * confirmada por REST. Sem Host/Admin, a confirmação não acontece.
   */
  async tocarNaSala(roomId, streamUrl, status = "playing", stationName = "DJ Bot") {
    const id = clean(roomId);
    if (!/^\d+-\d+$/.test(id)) throw new Error("ID de sala inválido.");

    const client = await this.ensureClient();
    const room = await client.rooms.fetch(id, { force: true });
    if (!room) throw new Error("Sala não encontrada.");

    const experienceUrl =
      room.relations?.media_experience || room.relations?.hangout_experience;
    if (!experienceUrl) {
      throw new Error("Essa sala não tem media_player de rádio (media_experience).");
    }

    const experience = await client.resource(experienceUrl);
    const playersUrl = experience?.relations?.media_players;
    if (!playersUrl) throw new Error("A sala não expõe media_players.");

    const playersNode = await client.resource(playersUrl);
    const players = [];
    if (playersNode?.data?.type?.provider) players.push(playersNode);
    if (Array.isArray(playersNode?.data?.items)) {
      for (const item of playersNode.data.items) {
        if (item?.data?.type?.provider) players.push(item);
        else if (item?.url) {
          try {
            const node = await client.resource(item.url);
            if (node?.data?.type?.provider) players.push(node);
          } catch {
            /* ignora */
          }
        }
      }
    }

    const player =
      players.find((node) => node.data?.type?.provider === "web_radio") ||
      players.find((node) => node.data?.type?.format === "radio") ||
      players[0];

    if (!player) throw new Error("Essa sala não tem media_player web_radio.");

    this.mediaPlayerUrl = player.url;

    const state = {
      station_name: status === "stopped" ? "" : clean(stationName) || "DJ Bot",
      station_url: status === "stopped" ? "" : clean(streamUrl),
      status: status === "stopped" ? "stopped" : "playing",
    };

    const readState = async () => {
      const fresh = await client.resource(player.url);
      return fresh?.data?.current_state || null;
    };

    const matches = (current) =>
      current &&
      String(current.station_url || "") === String(state.station_url || "") &&
      String(current.status || "") === String(state.status || "");

    const updateTarget = player.updates;
    if (updateTarget?.queue && updateTarget?.mount) {
      const payloads = [
        { current_state: state },
        { ...state },
        { data: { current_state: state }, id: player.url, type: "update" },
      ];

      for (const payload of payloads) {
        try {
          await client.realtime.send(updateTarget.queue, updateTarget.mount, payload);
        } catch (error) {
          console.warn(`[bot] IMQ media_player recusou: ${error?.message || error}`);
          continue;
        }
        await sleep(1_100);
        const current = await readState();
        if (matches(current)) {
          return { ok: true, playerUrl: player.url, state };
        }
      }
    }

    throw new Error(
      "O IMVU não confirmou a troca do media_player. O bot precisa ser Host/Admin da sala."
    );
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
    const radio = radioStream.snapshot(this.roomId);
    const sameAsTracker =
      credentials.username &&
      clean(process.env.IMVU_USER) &&
      credentials.username.toLowerCase() === clean(process.env.IMVU_USER).toLowerCase();
    const warnings = [];
    if (sameAsTracker) {
      warnings.push(
        process.env.BOT_ALLOW_SAME_ACCOUNT
          ? "O bot compartilha a conta do rastreador; os dois usam a mesma conta IMVU."
          : "A conta do bot e a mesma do rastreador. Use uma conta separada."
      );
    }
    if (this.radioWarning) warnings.push(this.radioWarning);

    return {
      configured: credentials.configured,
      loggedIn: Boolean(this.client?.authenticated),
      joining: this.joining,
      connected: Boolean(this.connected && this.session && !this.session.closed),
      roomId: this.roomId,
      roomName: this.roomName,
      joinedAt: this.joinedAt,
      current: radio.current,
      queue: radio.queue,
      playing: radio.playing,
      streamUrl: this.streamUrl,
      mediaPlayerUrl: this.mediaPlayerUrl,
      sendIntervalMs: MIN_SEND_INTERVAL_MS,
      pendingMessages: this.pendingSends,
      warning: warnings.join(" "),
      lastError: this.lastError,
    };
  }
}

export const musicBot = new MusicBot();
