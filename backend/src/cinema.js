const ROOM_RE = /^\d+-\d+$/;
const MAX_RECENT = 40;
const OCCUPANT_REFRESH_MS = 12_000;

/**
 * Modo Cinema: le o chat classico de uma sala SEM entrar nela.
 *
 * Usa a MESMA sessao IMQ do tracker (sem segundo login):
 * - assina a fila `imq_queue`/`messages` do chat (mensagens);
 * - le o roster por REST para os avatares e nomes.
 * Nenhum POST em /participants e feito, entao o bot nunca aparece na sala.
 */
export class CinemaService {
  constructor({ tracker, log = console } = {}) {
    this.tracker = tracker;
    this.log = log;
    this.rooms = new Map();
    this.pending = new Map();
  }

  occupantFromPerson(person) {
    if (!person?.cid) return null;
    if (String(person.cid) === String(this.tracker?.api?.cid || "")) return null;
    return {
      cid: String(person.cid),
      username: String(person.username || person.cid),
      displayName: String(person.displayName || person.username || person.cid),
      avatar: person.avatar || "",
      portrait: person.avatarPortrait || person.portrait || "",
      lookImage: person.lookImage || "",
      lookThumbnail: person.lookThumbnail || "",
      seatNumber: person.seatNumber || 0,
      isVip: Boolean(person.isVip),
      isAp: Boolean(person.isAp),
      online: Boolean(person.online),
    };
  }

  occupantsFromPeople(people) {
    const list = [];
    for (const person of people || []) {
      const occupant = this.occupantFromPerson(person);
      if (occupant) list.push(occupant);
    }
    return list;
  }

  async createEntry(roomId) {
    const tracker = this.tracker;
    const logged = await tracker.ensureLogin();
    if (!logged) throw new Error(tracker.api.lastError || "login falhou");

    const [chatEnv, people] = await Promise.all([
      tracker.api.getJson(`/chat/chat-${roomId}`).catch(() => null),
      tracker.api.roster(roomId, 0).catch(() => []),
    ]);

    let chatData = null;
    for (const node of Object.values(chatEnv?.denormalized || {})) {
      if (node?.data?.imq_queue) {
        chatData = node.data;
        break;
      }
    }
    const queue = String(chatData?.imq_queue || "");
    const mount = String(chatData?.imq_messages_mount || "");

    const entry = {
      roomId,
      clients: new Set(),
      recent: [],
      names: new Map(),
      occupants: new Map(),
      subscription: null,
      refreshTimer: null,
    };
    for (const occupant of this.occupantsFromPeople(people)) {
      entry.occupants.set(occupant.cid, occupant);
      entry.names.set(occupant.cid, occupant.username);
    }

    if (queue && mount) {
      entry.subscription = tracker.imq.observeQueue(queue, mount, (event) =>
        this.onChatPayload(entry, event)
      );
    }

    entry.refreshTimer = setInterval(() => {
      this.refreshOccupants(entry).catch(() => {});
    }, OCCUPANT_REFRESH_MS);
    entry.refreshTimer.unref?.();

    this.rooms.set(roomId, entry);
    this.log.info(
      `[cinema] observando ${roomId} sem entrar (chat: ${Boolean(entry.subscription)}, ${entry.occupants.size} ocupantes)`
    );
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
      chat: Boolean(entry.subscription),
      at: Date.now(),
    });
    for (const message of entry.recent) wsClient.send(message);
    return { roomId, chat: Boolean(entry.subscription) };
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
    if (entry.refreshTimer) clearInterval(entry.refreshTimer);
    entry.refreshTimer = null;
    try {
      entry.subscription?.close?.();
    } catch {
      /* ignora */
    }
    entry.subscription = null;
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

  async refreshOccupants(entry) {
    if (this.rooms.get(entry.roomId) !== entry) return;
    const people = await this.tracker.api.roster(entry.roomId, 0).catch(() => null);
    if (!people?.length) return; // nao remove todos por uma falha transitoria
    const next = new Map();
    for (const occupant of this.occupantsFromPeople(people)) {
      next.set(occupant.cid, occupant);
      entry.names.set(occupant.cid, occupant.username);
      if (!entry.occupants.has(occupant.cid)) {
        this.broadcast(entry, {
          type: "cinema_occupant_join",
          roomId: entry.roomId,
          occupant,
        });
      }
    }
    for (const [cid, occupant] of entry.occupants) {
      if (next.has(cid)) continue;
      this.broadcast(entry, {
        type: "cinema_occupant_leave",
        roomId: entry.roomId,
        cid,
      });
      entry.names.delete(cid);
    }
    entry.occupants = next;
  }

  onChatPayload(entry, event) {
    const payload = event?.payload;
    if (!payload || typeof payload.message !== "string") return;
    if (Number(payload.to || 0) !== 0) return; // ignora whispers
    let text = payload.message;
    if (!text || text.startsWith("*")) return; // comandos de outfit/seat/boot
    const action = /^\/me(\s|$)/i.test(text);
    if (action) text = text.slice(3).trimStart();
    if (!text) return;

    const cid = String(event?.userId || payload.userId || "");
    let nick = entry.names.get(cid);
    if (!nick) {
      nick = cid || "Alguém";
      this.tracker.api
        .resolveCid(cid)
        .then((person) => {
          if (person?.username) entry.names.set(cid, person.username);
        })
        .catch(() => {});
    }
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

  stats() {
    let clients = 0;
    for (const entry of this.rooms.values()) clients += entry.clients.size;
    return { rooms: this.rooms.size, clients };
  }
}
