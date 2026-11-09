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
const RECONNECT_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

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
    this.log.info(`[imq] reconectando em ${Math.round(wait / 1000)}s`);
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
      if (/^\d+-\d+$/.test(room)) all.add(`inv:/chat/chat-${room}`);
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
   * Assina chat-<cid>-1..N na MESMA conexao e mede o status de cada fila.
   * status 0 = fila existe (sala ativa/recente).
   */
  async probeQueues(cid, timeoutMs = 12_000) {
    if (!this.authed) return [];
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return [];
    const queues = [];
    for (let n = 1; n <= this.targetScan; n += 1) {
      queues.push(`inv:/chat/chat-${id}-${n}`);
    }
    const live = new Set();
    let remaining = queues.length;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const timer = setTimeout(() => resolveCompletion(), timeoutMs);

    const pairs = queues.map((queue) => {
      const op = this.nextOp();
      const rid = queue.slice("inv:/chat/chat-".length);
      this.pending.set(op, (status) => {
        if (status === 0) live.add(rid);
        remaining -= 1;
        if (remaining <= 0) resolveCompletion();
      });
      return { queue, op };
    });

    for (let i = 0; i < pairs.length; i += 400) {
      const chunk = pairs.slice(i, i + 400);
      const frames = chunk.map(({ queue, op }) => ({
        record: "subscription",
        name: queue,
        op_id: op,
      }));
      this.send({ record: "msg_c2g_subscribe", queues_with_results: frames });
      for (const { queue } of chunk) this.subscribed.add(queue);
    }

    await completion;
    clearTimeout(timer);
    for (const pair of pairs) this.pending.delete(pair.op);
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

  handleStateChange(message) {
    const queue = String(message.queue || "");
    const props = {};
    for (const property of message.properties || []) {
      if (!property?.key) continue;
      props[property.key] = b64d(property.value);
    }
    const cidMatch = /presence-(\d+)/.exec(queue);
    const cid = cidMatch ? cidMatch[1] : "";
    this.emit({ type: "state", cid, queue, props });
    if (!cid) return;

    let room = "";
    for (const key of ROOM_PROP_KEYS) {
      const value = String(props[key] || "");
      if (/^\d+-\d+$/.test(value)) {
        room = value;
        break;
      }
    }
    if (room) {
      this.emit({ type: "presence", action: "updated", room, cid, source: "presence" });
    }
  }

  handleSendMessage(message) {
    if (String(message.mount || "") !== "edge:participants") return;
    let payload;
    try {
      payload = JSON.parse(b64d(message.message));
    } catch {
      return;
    }
    const action = String(payload?.action || "");
    if (!action) return;
    const objects = Array.isArray(payload?.objects) ? payload.objects : [];
    const queue = String(message.queue || "");

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
