import { musicBot } from "./musicBot.js";

const ROOM_RE = /^\d+-\d+$/;
const MAX_RECENT = 40;

/**
 * Modo Cinema: observa o chat classico de uma sala SEM entrar nela.
 *
 * - `chat.observe()` le os participantes (join/leave/look) sem presenca.
 * - `realtime.listen(chat.imqQueue, chat.imqMessagesMount)` le as mensagens
 *   sem dar POST em /participants. O bot nunca aparece na sala.
 */
export class CinemaService {
  constructor({ log = console } = {}) {
    this.log = log;
    this.rooms = new Map();
    this.pending = new Map();
  }

  async getClient() {
    return musicBot.ensureClient();
  }

  async createEntry(roomId) {
    const client = await this.getClient();
    const room = await client.rooms.fetch(roomId, { force: true });
    if (!room) throw new Error("Sala nao encontrada.");

    const chat = await room.chat();
    const entry = {
      roomId,
      client,
      room,
      chat,
      clients: new Set(),
      recent: [],
      names: new Map(),
      observer: null,
      subscription: null,
    };

    if (chat?.imqQueue && chat?.imqMessagesMount) {
      entry.subscription = await client.realtime.listen(
        chat.imqQueue,
        chat.imqMessagesMount,
        (event) => this.onChatMessage(entry, event)
      );

      try {
        entry.observer = await chat.observe({ trackChanges: false });
        for (const participant of entry.observer.participants.values()) {
          const occupant = this.occupantFromParticipant(participant, client);
          if (occupant) entry.names.set(occupant.cid, occupant.username);
        }
        entry.observer.on("join", (participant) => {
          const occupant = this.occupantFromParticipant(participant, client);
          if (!occupant) return;
          entry.names.set(occupant.cid, occupant.username);
          this.broadcast(entry, {
            type: "cinema_occupant_join",
            roomId,
            occupant,
          });
        });
        entry.observer.on("leave", (event) => {
          this.broadcast(entry, {
            type: "cinema_occupant_leave",
            roomId,
            cid: String(event?.userId || ""),
          });
        });
        entry.observer.on("error", () => {
          /* reconecta pela Collection; nao derruba o cinema */
        });
      } catch (error) {
        this.log.warn(`[cinema] observe(${roomId}) falhou: ${error?.message || error}`);
      }
    }

    this.rooms.set(roomId, entry);
    this.log.info(`[cinema] observando ${roomId} (${room.name || "?"}) sem entrar`);
    return entry;
  }

  async join(wsClient, rawRoomId) {
    const roomId = String(rawRoomId || "").trim();
    if (!ROOM_RE.test(roomId)) throw new Error("ID de sala invalido.");

    let entry = this.rooms.get(roomId);
    if (!entry) {
      if (this.pending.has(roomId)) {
        await this.pending.get(roomId).catch(() => null);
        entry = this.rooms.get(roomId);
      } else {
        const promise = this.createEntry(roomId);
        this.pending.set(roomId, promise);
        try {
          entry = await promise;
        } finally {
          this.pending.delete(roomId);
        }
      }
    }
    if (!entry) throw new Error("Nao foi possivel iniciar o observador.");

    entry.clients.add(wsClient);
    wsClient.cinemaRooms?.add(roomId);
    wsClient.send({
      type: "cinema_ready",
      roomId,
      chat: Boolean(entry.chat?.imqQueue),
      at: Date.now(),
    });
    for (const message of entry.recent) wsClient.send(message);
    return { roomId, chat: Boolean(entry.chat?.imqQueue) };
  }

  leave(wsClient, rawRoomId) {
    const roomId = String(rawRoomId || "").trim();
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.clients.delete(wsClient);
    wsClient.cinemaRooms?.delete(roomId);
    if (!entry.clients.size) this.closeRoom(entry);
  }

  leaveAll(wsClient) {
    for (const roomId of [...(wsClient.cinemaRooms || [])]) {
      this.leave(wsClient, roomId);
    }
  }

  closeRoom(entry) {
    try {
      entry.subscription?.close?.();
    } catch {
      /* ignora */
    }
    try {
      entry.observer?.close?.();
    } catch {
      /* ignora */
    }
    this.rooms.delete(entry.roomId);
    this.log.info(`[cinema] parou de observar ${entry.roomId}`);
  }

  shutdown() {
    for (const entry of [...this.rooms.values()]) this.closeRoom(entry);
  }

  broadcast(entry, payload) {
    for (const client of entry.clients) {
      try {
        client.send(payload);
      } catch {
        /* ignora cliente morto */
      }
    }
  }

  onChatMessage(entry, realtimeEvent) {
    const raw = realtimeEvent?.message;
    let payload = raw;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload.message !== "string") return;
    if (Number(payload.to || 0) !== 0) return; // ignora whispers
    let text = payload.message;
    if (!text || text.startsWith("*")) return; // comandos de outfit/seat/boot
    const action = /^\/me(\s|$)/i.test(text);
    if (action) text = text.slice(3).trimStart();
    if (!text) return;

    const cid = String(realtimeEvent?.userId || payload.userId || "");
    const nick = entry.names.get(cid) || this.nickFromParticipant(entry, cid) || cid || "Alguém";
    const horario = new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    });
    const message = {
      type: "cinema_chat",
      roomId: entry.roomId,
      cid,
      nick,
      mensagem: text,
      horario,
      action,
      at: Date.now(),
    };
    entry.recent.push(message);
    if (entry.recent.length > MAX_RECENT) entry.recent.shift();
    this.broadcast(entry, message);
  }

  nickFromParticipant(entry, cid) {
    const participant = entry.observer?.get?.(cid);
    const user = participant?.user;
    if (user?.username) {
      entry.names.set(cid, user.username);
      return user.username;
    }
    return "";
  }

  occupantFromParticipant(participant, client) {
    if (!participant) return null;
    const cid = String(participant.userId || "");
    if (!cid) return null;
    if (String(client?.rest?.cid || "") === cid) return null; // bot nunca aparece
    const user = participant.user || {};
    return {
      cid,
      username: String(user.username || cid),
      displayName: String(user.displayName || user.username || cid),
      avatar: user.avatarImage || "",
      portrait: user.avatarPortraitImage || "",
      lookImage: participant.lookImage || participant.renderedImage || "",
      lookThumbnail: participant.lookThumbnail || participant.lookImage || "",
      seatNumber: participant.seatNumber || 0,
      isVip: Boolean(user.isVip),
      isAp: Boolean(user.isAp),
      online: true,
    };
  }

  stats() {
    let clients = 0;
    for (const entry of this.rooms.values()) clients += entry.clients.size;
    return { rooms: this.rooms.size, clients };
  }
}
