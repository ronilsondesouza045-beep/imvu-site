import WebSocket from "ws";
import { WS_URL, UA } from "./imvu.js";

const b64 = (value) => Buffer.from(String(value ?? ""), "utf8").toString("base64");
const b64d = (value) => {
  try {
    return Buffer.from(String(value ?? ""), "base64").toString("utf8");
  } catch {
    return String(value ?? "");
  }
};

const LIVE_ACTIONS = new Set(["updated", "created", "joined"]);
const LEFT_ACTIONS = new Set(["deleted", "left"]);
const ROOM_PROP_KEYS = ["room", "room_id", "location", "current_room", "chat_room"];
// Reconexao agressiva no primeiro erro (3s), com backoff depois.
const RECONNECT_MS = [3_000, 3_000, 6_000, 12_000, 30_000, 60_000];

/**
 * Extrai um roomId (`<cid>-<n>`) de um valor cru, URL (`.../room-123-4`)
 * ou node. Aceita query/hash no final.
 */
export function parseRoomId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+-\d+$/.test(raw)) return raw;
  const fromUrl = /room-(\d+-\d+)/i.exec(raw);
  if (fromUrl) return fromUrl[1];
  const trailing = /(\d+-\d+)(?:[/?#].*)?$/.exec(raw);
  return trailing ? trailing[1] : "";
}

/** Primeira propriedade conhecida do estado que aponta para uma sala. */
function roomIdFromProps(props) {
  if (!props) return "";
  for (const key of ROOM_PROP_KEYS) {
    const room = parseRoomId(props[key]);
    if (room) return room;
  }
  return "";
}

/** cid a partir de um valor solto (`123`, `user-123`, `avatar-123`). */
function cidFromState(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const tagged = /(?:user|avatar|presence)[-/](\d+)/i.exec(raw);
  if (tagged) return tagged[1];
  if (/^\d+$/.test(raw)) return raw;
  return "";
}

/** Descobre cid do ocupante nas propriedades ou no mount da fila. */
function cidFromProps(props, extra = {}) {
  if (props) {
    const keys = [
      "cid",
      "user_id",
      "userId",
      "avatar_id",
      "avatarId",
      "customer_id",
      "customerId",
      "user",
      "avatar",
    ];
    for (const key of keys) {
      const cid = cidFromState(props[key]);
      if (cid) return cid;
    }
  }
  return cidFromState(extra.mount) || cidFromState(extra.userId);
}

/**
 * Classifica a fila de estado:
 * - presence-<cid>      -> presenca do usuario (current_room vive aqui)
 * - presence-<roomId>   -> presenca da sala (ocupantes)
 * - chat-<roomId>       -> chat da sala (edge:participants)
 */
function queueInfo(queue) {
  const q = String(queue || "").trim();
  if (!q) return { kind: "", room: "", cid: "" };
  const roomPresence = /presence-(\d+-\d+)\s*$/.exec(q);
  if (roomPresence) return { kind: "room_presence", room: roomPresence[1], cid: "" };
  const userPresence = /presence-(\d+)\s*$/.exec(q);
  if (userPresence) return { kind: "user_presence", room: "", cid: userPresence[1] };
  // inv:/user/user-<cid>: o node do usuario tambem pode emitir current_room.
  const userNode = /user-(\d+)\s*$/.exec(q);
  if (userNode) return { kind: "user_presence", room: "", cid: userNode[1] };
  const roomChat = /chat-(\d+-\d+)\s*$/.exec(q);
  if (roomChat) return { kind: "room_chat", room: roomChat[1], cid: "" };
  return { kind: "", room: "", cid: "" };
}

function actionFromProps(props) {
  const raw = String(props?.action || props?.event || "").trim().toLowerCase();
  if (["left", "leave", "deleted", "removed", "exit", "exited"].includes(raw)) return "left";
  return "updated";
}

export function isLiveAction(action) {
  return LIVE_ACTIONS.has(String(action || ""));
}

export function isLeftAction(action) {
  return LEFT_ACTIONS.has(String(action || ""));
}

const now = () => Date.now();

export class ImqClient {
  constructor({
    getAuth,
    onEvent,
    onAuthError = null,
    log = console,
    wsUrl = WS_URL,
    targetScan = 800,
  }) {
    this.getAuth = getAuth;
    this.onEvent = onEvent;
    this.onAuthError = onAuthError;
    this.log = log;
    this.wsUrl = wsUrl;
    this.targetScan = Math.max(1, Math.min(800, Number(targetScan) || 800));

    this.ws = null;
    this.stopped = true;
    this.connecting = false;
    this.authed = false;
    this.connected = false;

    this.attempt = 0;
    this.opId = 1000;
    this.connectOp = 0;
    this.pending = new Map();
    this.subscribed = new Set();

    this.targetCids = new Set();
    this.rooms = new Set();
    // Filas avulsas (ex.: chat do Modo Cinema) e handlers de mensagem.
    this.customQueues = new Set();
    this.messageHandlers = new Map();

    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.keepaliveTimer = null;
    this.lastMessageAt = 0;
  }

  get ready() {
    return this.connected && this.authed;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.startTimers();
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.authed = false;
    this.connected = false;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close(1000, "bye");
    } catch {
      /* ignora */
    }
    this.ws = null;
    this.subscribed.clear();
    this.pending.clear();
  }

  nextOp() {
    this.opId += 1;
    return this.opId;
  }

  async connect() {
    if (this.stopped || this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connecting = true;
    let auth;
    try {
      auth = await this.getAuth();
    } catch (error) {
      this.connecting = false;
      this.log.warn(`[imq] auth indisponivel: ${error?.message || error}`);
      this.scheduleReconnect();
      return;
    }
    if (!auth?.cid || !auth?.sessionId) {
      this.connecting = false;
      this.log.warn("[imq] sem cid/session para conectar");
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      this.connecting = false;
      return;
    }

    const headers = {
      "User-Agent": UA,
      Origin: "https://www.imvu.com",
    };
    if (auth.username) headers.Cookie = `_imvu_avnm=${auth.username}`;

    let socket;
    try {
      socket = new WebSocket(this.wsUrl, {
        headers,
        handshakeTimeout: 20_000,
        perMessageDeflate: false,
      });
    } catch (error) {
      this.connecting = false;
      this.log.warn(`[imq] falha ao abrir socket: ${error?.message || error}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.connecting = false;

    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.attempt = 0;
      this.authed = false;
      this.connected = false;
      this.subscribed.clear();
      this.pending.clear();
      this.lastMessageAt = now();
      this.connectOp = this.nextOp();
      const metadata = [
        { record: "metadata", key: "app", value: b64("imvu_next") },
        { record: "metadata", key: "platform_type", value: b64("big") },
      ];
      this.send({
        record: "msg_c2g_connect",
        user_id: auth.cid,
        cookie: b64(auth.sessionId),
        metadata,
        op_id: this.connectOp,
      });
      this.log.info("[imq] socket aberto, autenticando");
    });

    socket.on("message", (data) => {
      if (this.ws !== socket) return;
      this.lastMessageAt = now();
      this.handle(String(data));
    });

    socket.on("error", (error) => {
      if (this.ws !== socket) return;
      this.log.warn(`[imq] erro: ${error?.message || error}`);
    });

    socket.on("close", (code, reason) => {
      if (this.ws !== socket) return;
      this.log.info(`[imq] fechado (${code}${reason ? " " + reason : ""})`);
      this.authed = false;
      this.connected = false;
      this.subscribed.clear();
      this.pending.clear();
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt += 1;
    this.log.info(`[IMQ] reconectando em ${Math.round(wait / 1000)}s (tentativa ${this.attempt + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  startTimers() {
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => {
        if (this.stopped) return;
        if (!this.ws) return;
        const idle = now() - this.lastMessageAt;
        if (idle > 60_000) {
          this.log.warn("[imq] watchdog: 60s sem mensagem, reciclando socket");
          try {
            this.ws.terminate();
          } catch {
            /* ignora */
          }
        }
      }, 15_000);
    }
    if (!this.keepaliveTimer) {
      this.keepaliveTimer = setInterval(() => {
        if (this.stopped || !this.authed) return;
        this.resubscribe();
      }, 30_000);
    }
  }

  clearTimers() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.watchdogTimer = null;
    this.keepaliveTimer = null;
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  targetQueues(cid) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return [];
    const queues = [];
    for (let n = 1; n <= this.targetScan; n += 1) {
      queues.push(`inv:/chat/chat-${id}-${n}`);
    }
    queues.push(`inv:/user/user-${id}`);
    queues.push(`inv:/presence/presence-${id}`);
    return queues;
  }

  desiredQueues() {
    const all = new Set();
    for (const cid of this.targetCids) {
      for (const queue of this.targetQueues(cid)) all.add(queue);
    }
    for (const room of this.rooms) {
      if (!/^\d+-\d+$/.test(room)) continue;
      // Chat da sala: edge:participants entrega joined/left/updated.
      all.add(`inv:/chat/chat-${room}`);
      // Presenca da sala: estado dos ocupantes em tempo real, inclusive
      // em sala privada de terceiro onde o roster HTTP vem 403.
      all.add(`inv:/presence/presence-${room}`);
    }
    for (const queue of this.customQueues) {
      if (queue) all.add(queue);
    }
    return [...all];
  }

  addTarget(cid) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return;
    if (this.targetCids.has(id)) return;
    this.targetCids.add(id);
    if (this.authed) this.reconcile();
  }

  removeTarget(cid) {
    const id = String(cid || "");
    if (!this.targetCids.delete(id)) return;
    if (this.authed) this.reconcile();
  }

  addRoom(rid) {
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return;
    if (this.rooms.has(id)) return;
    this.rooms.add(id);
    if (this.authed) this.reconcile();
  }

  removeRoom(rid) {
    const id = String(rid || "");
    if (!this.rooms.delete(id)) return;
    if (this.authed) this.reconcile();
  }

  reconcile() {
    if (!this.authed) return;
    const desired = new Set(this.desiredQueues());
    const toAdd = [...desired].filter((queue) => !this.subscribed.has(queue));
    const toRemove = [...this.subscribed].filter((queue) => !desired.has(queue));
    if (toAdd.length) this.subscribeQueues(toAdd);
    if (toRemove.length) this.unsubscribeQueues(toRemove);
  }

  /**
   * Assina uma fila/mount avulsa e entrega as mensagens decodificadas
   * (ex.: chat classico `/chat/<id>` mount `messages`). Nao entra na sala.
   */
  observeQueue(rawQueue, rawMount, handler) {
    const queue = String(rawQueue || "").trim();
    const mount = String(rawMount || "").trim();
    if (!queue || !mount || typeof handler !== "function") {
      return { close() {} };
    }
    const key = `${queue}|${mount}`;
    let handlers = this.messageHandlers.get(key);
    if (!handlers) {
      handlers = new Set();
      this.messageHandlers.set(key, handlers);
    }
    handlers.add(handler);
    this.customQueues.add(queue);
    if (this.authed) this.subscribeQueues([queue]);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        const set = this.messageHandlers.get(key);
        if (set) {
          set.delete(handler);
          if (!set.size) this.messageHandlers.delete(key);
        }
        if (!this.messageHandlers.has(key)) {
          this.customQueues.delete(queue);
          if (this.authed) this.unsubscribeQueues([queue]);
        }
      },
    };
  }

  resubscribe() {
    if (!this.authed) return;
    const desired = this.desiredQueues();
    if (desired.length) this.subscribeQueues(desired);
  }

  sendSubscriptionFrames(queues, { unsubscribe = false } = {}) {
    let sent = 0;
    for (let i = 0; i < queues.length; i += 400) {
      const chunk = queues.slice(i, i + 400);
      const frames = chunk.map((queue) => ({
        record: "subscription",
        name: queue,
        op_id: this.nextOp(),
      }));
      const message = unsubscribe
        ? { record: "msg_c2g_unsubscribe", queues_with_results: frames }
        : { record: "msg_c2g_subscribe", queues_with_results: frames };
      if (this.send(message)) sent += chunk.length;
    }
    return sent;
  }

  subscribeQueues(queues) {
    if (!queues?.length) return;
    const clean = [...new Set(queues.filter(Boolean))];
    this.sendSubscriptionFrames(clean, { unsubscribe: false });
    for (const queue of clean) this.subscribed.add(queue);
  }

  unsubscribeQueues(queues) {
    if (!queues?.length) return;
    const clean = [...new Set(queues.filter(Boolean))];
    this.sendSubscriptionFrames(clean, { unsubscribe: true });
    for (const queue of clean) this.subscribed.delete(queue);
  }

  /**
   * Assina um lote de filas e devolve Map<queue, status>.
   * Lotes pequenos (~300) respondem em <1s; 800 numa tacada estourava o
   * timeout e o servidor nao devolvia os status.
   */
  async probeQueueChunk(queues, timeoutMs = 4_000) {
    const statuses = new Map();
    if (!queues?.length || !this.authed) return statuses;
    let remaining = queues.length;
    let resolveAll = null;
    const all = new Promise((resolve) => {
      resolveAll = resolve;
    });
    const timer = setTimeout(() => resolveAll(), Math.max(500, timeoutMs));

    const frames = queues.map((queue) => {
      const op = this.nextOp();
      this.pending.set(op, (status) => {
        statuses.set(queue, status);
        remaining -= 1;
        if (remaining <= 0) resolveAll();
      });
      return { record: "subscription", name: queue, op_id: op };
    });

    const sent = this.send({ record: "msg_c2g_subscribe", queues_with_results: frames });
    if (!sent) {
      clearTimeout(timer);
      for (const frame of frames) this.pending.delete(frame.op_id);
      return statuses;
    }
    for (const frame of frames) this.subscribed.add(frame.name);

    await all;
    clearTimeout(timer);
    for (const frame of frames) this.pending.delete(frame.op_id);
    return statuses;
  }

  /**
   * Assina chat-<cid>-1..N em lotes e mede o status de cada fila.
   * status 0 = fila existe (sala ativa/recente).
   */
  async probeQueues(cid, timeoutMs = 12_000) {
    if (!this.authed) return [];
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return [];
    const live = new Set();
    const deadline = now() + timeoutMs;
    const chunkSize = 300;

    for (let n = 1; n <= this.targetScan; n += chunkSize) {
      if (now() >= deadline) break;
      const queues = [];
      for (let k = n; k < Math.min(this.targetScan + 1, n + chunkSize); k += 1) {
        queues.push(`inv:/chat/chat-${id}-${k}`);
      }
      const chunkTimeout = Math.min(4_000, Math.max(1_000, deadline - now()));
      const statuses = await this.probeQueueChunk(queues, chunkTimeout);
      for (const [queue, status] of statuses) {
        if (status !== 0) continue;
        const rid = queue.slice("inv:/chat/chat-".length);
        if (/^\d+-\d+$/.test(rid)) live.add(rid);
      }
    }
    return [...live];
  }

  handle(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const record = message?.record;
    if (!record) return;

    switch (record) {
      case "msg_g2c_result":
        this.handleResult(message);
        break;
      case "msg_g2c_state_change":
        this.handleStateChange(message);
        break;
      case "msg_g2c_send_message":
        this.handleSendMessage(message);
        break;
      case "msg_g2c_pong":
        break;
      case "msg_g2c_joined_queue":
      case "msg_g2c_left_queue":
        break;
      case "msg_g2c_create_mount":
        this.handleCreateMount(message);
        break;
      default:
        break;
    }
  }

  handleResult(message) {
    const opId = Number(message.op_id);
    const status = Number(message.status);
    const error = String(message.error_message || message.errorMessage || message.error || "");

    if (opId === this.connectOp) {
      if (status !== 0 || error) {
        this.log.error(`[imq] autenticacao falhou (status ${status}${error ? ": " + error : ""})`);
        try {
          this.onAuthError?.();
        } catch {
          /* ignora */
        }
        this.emit({ type: "imq_error", message: error || `connect ${status}` });
        try {
          this.ws?.terminate();
        } catch {
          /* ignora */
        }
        return;
      }
      if (!this.authed) {
        this.authed = true;
        this.connected = true;
        this.log.info("[imq] autenticado, abrindo floodgates");
        this.send({ record: "msg_c2g_open_floodgates" });
        this.emit({ type: "imq_ready" });
        setTimeout(() => {
          if (this.authed) this.reconcile();
        }, 1_200);
      }
      return;
    }

    const callback = this.pending.get(opId);
    if (callback) {
      this.pending.delete(opId);
      callback(status);
    }
  }

  processStateProps(queue, props, extra = {}) {
    const state = props || {};
    const info = queueInfo(queue);
    const propRoom = roomIdFromProps(state);
    const stateCid = cidFromProps(state, extra);
    const room = propRoom || info.room;
    const cid = info.cid || stateCid;

    this.emit({ type: "state", cid, queue, room, props: state });

    if (info.kind === "user_presence") {
      // Fila presence-<cid>: props.current_room/room = sala atual do alvo.
      if (propRoom) {
        this.emit({ type: "presence", action: "updated", room: propRoom, cid: info.cid, source: "presence" });
      }
      return;
    }

    if (info.kind === "room_presence" || info.kind === "room_chat") {
      // Fila da sala: o mount/user_id das propriedades identifica o ocupante.
      // Se o estado apontar para OUTRA sala, ela vence a sala da propria fila.
      let occupant = stateCid;
      const movedRoom = propRoom && info.room && propRoom !== info.room ? propRoom : "";
      if (!occupant) {
        const ownerCid = info.room.split("-")[0];
        // chat-<cid>-* dos alvos: o dono da fila e o proprio alvo. Sem isso,
        // um evento updated em chat-<cid>-1 (My Room) sem user_id era ignorado.
        if (this.targetCids.has(ownerCid)) occupant = ownerCid;
      }
      if (occupant && (movedRoom || info.room)) {
        this.emit({
          type: "presence",
          action: actionFromProps(state),
          room: movedRoom || info.room,
          cid: occupant,
          source: info.kind === "room_presence" ? "room_presence" : "room_chat",
        });
      }
      return;
    }

    if (room && cid) {
      this.emit({ type: "presence", action: actionFromProps(state), room, cid, source: "state" });
    }
  }

  handleStateChange(message) {
    const queue = String(message.queue || "");
    const props = {};
    for (const property of message.properties || []) {
      if (!property?.key) continue;
      props[property.key] = b64d(property.value);
    }
    if (message.properties && !Array.isArray(message.properties) && typeof message.properties === "object") {
      for (const [key, value] of Object.entries(message.properties)) {
        if (props[key] !== undefined) continue;
        props[key] = value === null || value === undefined ? "" : String(value);
      }
    }
    // Alguns gateways mandam o delta ja decodificado em vez de properties.
    if (message.delta && typeof message.delta === "object" && !Array.isArray(message.delta)) {
      for (const [key, value] of Object.entries(message.delta)) {
        if (props[key] !== undefined) continue;
        props[key] = value === null || value === undefined ? "" : String(value);
      }
    }
    this.processStateProps(queue, props, {
      mount: String(message.mount || ""),
      userId: String(message.user_id || ""),
    });
  }

  /**
   * O gateway manda msg_g2c_create_mount quando uma fila ganha um mount.
   * Para a fila de presenca ele traz o estado inicial (inclusive a sala
   * atual), o que resolve alvo parado sem esperar um novo evento.
   */
  handleCreateMount(message) {
    const queue = String(message.queue || "");
    const mount = String(message.mount || "");
    const info = queueInfo(queue);
    if (!info.kind) return;

    const props = {};
    for (const property of message.properties || []) {
      if (!property?.key) continue;
      props[property.key] = b64d(property.value);
    }
    if (message.state && typeof message.state === "object" && !Array.isArray(message.state)) {
      for (const [key, value] of Object.entries(message.state)) {
        if (props[key] !== undefined) continue;
        props[key] = value === null || value === undefined ? "" : String(value);
      }
    }
    if (!Object.keys(props).length) return;

    this.emit({ type: "mount", queue, mount, props });
    if (info.kind === "user_presence" || info.kind === "room_presence") {
      this.processStateProps(queue, props, {
        mount,
        userId: String(message.user_id || ""),
      });
    }
  }

  handleSendMessage(message) {
    const queue = String(message.queue || "");
    const mount = String(message.mount || "");
    let handlers = this.messageHandlers.get(`${queue}|${mount}`);
    if (!handlers?.size && this.messageHandlers.size) {
      for (const [key, set] of this.messageHandlers) {
        const sep = key.indexOf("|");
        const registeredQueue = key.slice(0, sep);
        const registeredMount = key.slice(sep + 1);
        if (registeredMount !== mount) continue;
        if (
          registeredQueue === queue ||
          queue.endsWith(registeredQueue) ||
          registeredQueue.endsWith(queue)
        ) {
          handlers = set;
          break;
        }
      }
    }
    if (handlers?.size) {
      let payload;
      try {
        payload = JSON.parse(b64d(message.message));
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      let userId = message.user_id ? b64d(message.user_id) : String(message.userId || "");
      if (!/^\d+$/.test(userId)) userId = String(payload.userId || "");
      for (const handler of handlers) {
        try {
          handler({ queue, mount, userId, payload });
        } catch {
          /* handler do cinema nao derruba o radar */
        }
      }
      return;
    }
    if (mount !== "edge:participants") return;
    let payload;
    try {
      payload = JSON.parse(b64d(message.message));
    } catch {
      return;
    }
    const action = String(payload?.action || "");
    if (!action) return;
    const objects = Array.isArray(payload?.objects) ? payload.objects : [];

    let room = queue.startsWith("inv:/chat/chat-")
      ? queue.slice("inv:/chat/chat-".length)
      : "";
    if (!room) {
      const blob = objects.join(" ");
      const match = /chat-(\d+-\d+)/.exec(blob);
      room = match ? match[1] : "";
    }
    if (!room) return;

    for (const object of objects) {
      const match = /\/user-(\d+)/.exec(String(object));
      if (!match) continue;
      this.emit({
        type: "presence",
        action,
        room,
        cid: match[1],
        source: "edge",
      });
    }
  }

  emit(event) {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.log.warn(`[imq] handler falhou: ${error?.message || error}`);
    }
  }
}
