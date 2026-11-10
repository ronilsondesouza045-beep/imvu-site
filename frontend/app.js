(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const params = new URLSearchParams(window.location.search);

  const configuredBackend = String(window.RADAR_BACKEND || params.get("backend") || "").trim();
  const isHttpPage = window.location.protocol === "http:" || window.location.protocol === "https:";
  const HTTP_BASE = (configuredBackend || (isHttpPage ? window.location.origin : "http://localhost:8080")).replace(/\/+$/, "");

  let WS_URL = "ws://localhost:8080";
  try {
    const url = new URL(HTTP_BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    WS_URL = url.toString().replace(/\/$/, "");
  } catch {
    WS_URL = "ws://localhost:8080";
  }

  const state = {
    ws: null,
    connected: false,
    reconnectTimer: null,
    reconnectDelay: 1000,
    currentNick: "",
    watching: false,
    target: null,
    room: null,
    occupants: [],
    status: "idle",
    statusText: "Aguardando",
    watchStartedAt: 0,
    serverStatus: null,
  };

  const alerts = {
    enabled: false,
    mode: "",
    permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    settings: { occupants: false },
    subscription: null,
    nick: "",
    expiresAt: 0,
    registration: null,
    publicKey: "",
    pushEnabled: false,
    busy: false,
    boundToBackend: false,
    pendingTimer: null,
    expiryTimer: null,
    closeTimer: null,
    log: [],
  };

  const els = {
    connection: $("#connection"),
    connectionText: $("#connectionText"),
    watchForm: $("#watchForm"),
    nickInput: $("#nickInput"),
    watchBtn: $("#watchBtn"),
    stopBtn: $("#stopBtn"),
    targetBadges: $("#targetBadges"),
    targetEmpty: $("#targetEmpty"),
    targetEmptyAvatar: $("#targetEmptyAvatar"),
    targetEmptyTitle: $("#targetEmptyTitle"),
    targetEmptyText: $("#targetEmptyText"),
    targetContent: $("#targetContent"),
    targetAvatar: $("#targetAvatar"),
    targetName: $("#targetName"),
    targetUser: $("#targetUser"),
    targetCid: $("#targetCid"),
    targetOnline: $("#targetOnline"),
    targetSince: $("#targetSince"),
    roomBackdrop: $("#roomBackdrop"),
    roomStatus: $("#roomStatus"),
    roomStatusText: $("#roomStatusText"),
    roomEmpty: $("#roomEmpty"),
    roomEmptyTitle: $("#roomEmptyTitle"),
    roomEmptyText: $("#roomEmptyText"),
    roomContent: $("#roomContent"),
    roomName: $("#roomName"),
    roomPrivacy: $("#roomPrivacy"),
    roomId: $("#roomId"),
    roomOwner: $("#roomOwner"),
    roomOccupancy: $("#roomOccupancy"),
    roomImvuLink: $("#roomImvuLink"),
    roomWebLink: $("#roomWebLink"),
    copyRoomBtn: $("#copyRoomBtn"),
    roomDirect: $("#roomDirect"),
    occupantCount: $("#occupantCount"),
    occupantHint: $("#occupantHint"),
    occupants: $("#occupants"),
    toasts: $("#toasts"),
    alertsBtn: $("#alertsBtn"),
    alertsDot: $("#alertsDot"),
    alertsOverlay: $("#alertsOverlay"),
    alertsPanel: $("#alertsPanel"),
    closeAlertsBtn: $("#closeAlertsBtn"),
    enableAlertsBtn: $("#enableAlertsBtn"),
    testAlertBtn: $("#testAlertBtn"),
    disableAlertsBtn: $("#disableAlertsBtn"),
    alertOccupants: $("#alertOccupants"),
    alertsStatus: $("#alertsStatus"),
    alertsStatusText: $("#alertsStatusText"),
    alertsInfo: $("#alertsInfo"),
    alertLog: $("#alertLog"),
  };

  // ---------------- utilidades ----------------

  const timeOf = (value) => {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  const readableLink = (value) => {
    const link = String(value || "");
    if (!link) return "";
    try {
      return decodeURIComponent(link.replace(/\+/g, "%20"));
    } catch {
      return link;
    }
  };

  const initialsOf = (person) => {
    const raw = String(person?.displayName || person?.username || person?.nick || "?").trim();
    const clean = raw.replace(/[^\p{L}\p{N}]+/gu, "");
    return (clean.slice(0, 2) || "?").toUpperCase();
  };

  const proxiedImage = (raw) => {
    const url = String(raw || "").trim();
    if (!url) return "";
    if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
    return `${HTTP_BASE}/api/avatar?u=${encodeURIComponent(url)}`;
  };

  const setClass = (element, className) => {
    if (element) element.className = className;
  };

  const safeStorage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* modo privado */
      }
    },
  };

  // ---------------- conexao WebSocket ----------------

  function setConnection(kind) {
    const map = {
      online: ["conn conn-online", "online"],
      connecting: ["conn conn-connecting", "conectando"],
      offline: ["conn conn-offline", "offline"],
    };
    const [className, label] = map[kind] || map.offline;
    setClass(els.connection, className);
    if (els.connectionText) els.connectionText.textContent = label;
  }

  function wsSend(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    try {
      state.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    setConnection("connecting");

    let socket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      setConnection("offline");
      scheduleReconnect();
      return;
    }
    state.ws = socket;

    socket.addEventListener("open", () => {
      if (state.ws !== socket) return;
      state.connected = true;
      state.reconnectDelay = 1000;
      setConnection("online");
      if (state.watching && state.currentNick) {
        wsSend({ type: "watch", nick: state.currentNick });
      }
    });

    socket.addEventListener("message", (event) => {
      if (state.ws !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(message);
    });

    socket.addEventListener("close", () => {
      if (state.ws !== socket) return;
      state.connected = false;
      state.ws = null;
      setConnection("offline");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* ignora */
      }
    });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const wait = state.reconnectDelay;
    state.reconnectDelay = Math.min(Math.round(state.reconnectDelay * 1.7), 15_000);
    setConnection("offline");
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, wait);
  }

  // ---------------- alertas / Web Push ----------------

  function alertsLoadSettings() {
    alerts.enabled = safeStorage.get("radar:alertsEnabled") === "1";
    alerts.mode = safeStorage.get("radar:alertMode") || "";
    alerts.settings.occupants = safeStorage.get("radar:alertOccupants") === "1";
    alerts.expiresAt = Number(safeStorage.get("radar:alertExpires") || 0) || 0;
    alerts.nick = safeStorage.get("radar:alertNick") || "";
    try {
      const parsed = JSON.parse(safeStorage.get("radar:alertLog") || "[]");
      alerts.log = Array.isArray(parsed) ? parsed : [];
    } catch {
      alerts.log = [];
    }
  }

  function alertsSaveSettings() {
    safeStorage.set("radar:alertsEnabled", alerts.enabled ? "1" : "0");
    safeStorage.set("radar:alertMode", alerts.mode || "");
    safeStorage.set("radar:alertOccupants", alerts.settings.occupants ? "1" : "0");
    safeStorage.set("radar:alertExpires", String(alerts.expiresAt || 0));
    safeStorage.set("radar:alertNick", alerts.nick || "");
    safeStorage.set("radar:alertLog", JSON.stringify(alerts.log.slice(0, 20)));
  }

  function alertLogAdd(text) {
    if (!text) return;
    alerts.log.unshift({ at: Date.now(), text: String(text).slice(0, 160) });
    alerts.log = alerts.log.slice(0, 20);
    safeStorage.set("radar:alertLog", JSON.stringify(alerts.log));
    alertLogRender();
  }

  function alertLogRender() {
    if (!els.alertLog) return;
    els.alertLog.replaceChildren();
    if (!alerts.log.length) {
      els.alertLog.textContent = "Nenhum aviso ainda.";
      return;
    }
    for (const entry of alerts.log.slice(0, 12)) {
      const item = document.createElement("div");
      item.className = "alert-log-item";
      const time = document.createElement("span");
      time.className = "alert-log-time";
      time.textContent = timeOf(entry.at);
      const text = document.createElement("span");
      text.textContent = entry.text;
      item.append(time, text);
      els.alertLog.appendChild(item);
    }
  }

  function scheduleAlertExpiry() {
    if (alerts.expiryTimer) {
      clearTimeout(alerts.expiryTimer);
      alerts.expiryTimer = null;
    }
    if (!alerts.enabled || !alerts.expiresAt) return;
    const wait = Math.max(0, alerts.expiresAt - Date.now()) + 1_000;
    alerts.expiryTimer = setTimeout(() => {
      alerts.expiryTimer = null;
      if (alerts.expiresAt && alerts.expiresAt <= Date.now()) {
        alerts.enabled = false;
        alerts.mode = "";
        alerts.subscription = null;
        alerts.expiresAt = 0;
        alerts.nick = "";
        alerts.boundToBackend = false;
        alertsSaveSettings();
        alertsRender();
        alertLogAdd("Alertas expiraram");
      }
    }, Math.min(wait, 2 ** 31 - 1));
  }

  function alertsRender() {
    if (!els.alertsBtn) return;
    els.alertsBtn.classList.toggle("is-on", alerts.enabled);
    els.alertsDot?.classList.toggle("hidden", !alerts.enabled);

    if (els.alertsStatus) {
      els.alertsStatus.className = "alerts-status";
      let kind = "";
      let text = "Alertas desativados";
      if (alerts.busy) {
        kind = "is-warn";
        text = "Ativando alertas...";
      } else if (alerts.permission === "denied") {
        kind = "is-error";
        text = "Permissão de notificação negada";
      } else if (typeof Notification === "undefined") {
        kind = "is-warn";
        text = "Navegador sem suporte a notificações";
      } else if (alerts.enabled) {
        kind = "is-active";
        const expiry = alerts.expiresAt ? ` até ${timeOf(alerts.expiresAt)}` : "";
        text = `Alertas ativos${expiry} · ${alerts.mode === "push" ? "push" : "aba aberta"}`;
      }
      if (kind) els.alertsStatus.classList.add(kind);
      if (els.alertsStatusText) els.alertsStatusText.textContent = text;
    }

    els.enableAlertsBtn?.classList.toggle("hidden", alerts.enabled);
    els.disableAlertsBtn?.classList.toggle("hidden", !alerts.enabled);
    if (els.enableAlertsBtn) els.enableAlertsBtn.disabled = alerts.busy;
    if (els.testAlertBtn) els.testAlertBtn.disabled = alerts.busy;
    if (els.disableAlertsBtn) els.disableAlertsBtn.disabled = alerts.busy;
    if (els.alertOccupants) els.alertOccupants.checked = alerts.settings.occupants;

    if (els.alertsInfo) {
      let info = "";
      if (!state.currentNick) {
        info = "Vigie um nick primeiro e ative os alertas.";
      } else if (alerts.enabled) {
        info =
          alerts.mode === "push"
            ? `Monitorando @${alerts.nick || state.currentNick}. Pode fechar o site: o push continua.`
            : `Monitorando @${alerts.nick || state.currentNick}. Mantenha a aba aberta em segundo plano.`;
      } else if (alerts.pushEnabled) {
        info = `Pronto para ativar alertas para @${state.currentNick}.`;
      } else {
        info = "Push indisponível neste navegador; os alertas funcionam com a aba aberta.";
      }
      els.alertsInfo.textContent = info;
    }

    alertLogRender();
  }

  function alertsOpen() {
    if (!els.alertsPanel || !els.alertsOverlay) return;
    if (alerts.closeTimer) { clearTimeout(alerts.closeTimer); alerts.closeTimer = null; }
    alertsRender();
    els.alertsPanel.classList.remove("hidden");
    els.alertsOverlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      els.alertsPanel.classList.add("is-open");
      els.alertsOverlay.classList.add("is-open");
    });
    document.body.style.overflow = "hidden";
  }

  function alertsClose() {
    if (!els.alertsPanel || !els.alertsOverlay) return;
    els.alertsPanel.classList.remove("is-open");
    els.alertsOverlay.classList.remove("is-open");
    document.body.style.overflow = "";
    alerts.closeTimer = setTimeout(() => {
      els.alertsPanel.classList.add("hidden");
      els.alertsOverlay.classList.add("hidden");
      alerts.closeTimer = null;
    }, 260);
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    if (alerts.registration) return alerts.registration;
    try {
      alerts.registration = await navigator.serviceWorker.register("sw.js");
      return alerts.registration;
    } catch {
      return null;
    }
  }

  async function fetchPushConfig() {
    try {
      const response = await fetch(`${HTTP_BASE}/api/push/key`, { cache: "no-store" });
      if (!response.ok) return false;
      const json = await response.json();
      alerts.publicKey = String(json?.key || "");
      alerts.pushEnabled = Boolean(json?.enabled && alerts.publicKey);
      return alerts.pushEnabled;
    } catch {
      alerts.pushEnabled = false;
      alerts.publicKey = "";
      return false;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (String(base64String).length % 4)) % 4);
    const base64 = (String(base64String) + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
    return output;
  }

  function subscriptionKeyMatches(subscription, key) {
    try {
      const existing = subscription?.options?.applicationServerKey;
      if (!existing) return true;
      const current = new Uint8Array(existing);
      const wanted = urlBase64ToUint8Array(key);
      if (current.length !== wanted.length) return false;
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] !== wanted[index]) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  async function getPushSubscription() {
    const registration = await registerServiceWorker();
    if (!registration || !("PushManager" in window)) return null;
    if (!alerts.publicKey) await fetchPushConfig();
    if (!alerts.publicKey) return null;

    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionKeyMatches(subscription, alerts.publicKey)) {
      try {
        await subscription.unsubscribe();
      } catch {
        /* ignora */
      }
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(alerts.publicKey),
      });
    }
    return subscription;
  }

  async function showLocalNotification(title, body) {
    const registration = alerts.registration || (await registerServiceWorker());
    if (!registration) return false;
    try {
      await registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: `radar-local-${Date.now()}`,
        data: { url: window.location.href },
      });
      return true;
    } catch {
      return false;
    }
  }

  function maybeLocalNotify(title, body) {
    if (!alerts.enabled || alerts.mode !== "local") return;
    if (!document.hidden) return;
    showLocalNotification(title, body);
  }

  function wsSendWhenOpen(payload, timeout = 6_000) {
    if (wsSend(payload)) return Promise.resolve(true);
    connect();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (wsSend(payload)) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started > timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, 250);
    });
  }

  async function sendAlertStart(nick) {
    if (!alerts.subscription?.endpoint) return false;
    const sent = await wsSendWhenOpen({
      type: "alert_start",
      nick,
      subscription: alerts.subscription,
      settings: { occupants: alerts.settings.occupants },
    });
    if (!sent) return false;
    alerts.busy = true;
    alertsRender();
    if (alerts.pendingTimer) clearTimeout(alerts.pendingTimer);
    alerts.pendingTimer = setTimeout(() => {
      alerts.pendingTimer = null;
      if (alerts.boundToBackend) return;
      alerts.busy = false;
      alertsRender();
      toast("O servidor não confirmou os alertas", {
        kind: "warn",
        detail: "Tente ativar novamente.",
      });
    }, 20_000);
    return true;
  }

  async function enableAlerts() {
    if (alerts.busy) return;
    if (!state.currentNick) {
      alertsOpen();
      toast("Vigie um nick primeiro", { kind: "warn", detail: "Digite o nick e clique em Vigiar." });
      return;
    }
    if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
      toast("Este navegador não suporta notificações", { kind: "danger" });
      return;
    }

    alerts.busy = true;
    alertsRender();
    try {
      const permission = await Notification.requestPermission();
      alerts.permission = permission;
      if (permission !== "granted") {
        toast("Permissão de notificação negada", {
          kind: "warn",
          detail: "Libere as notificações nas configurações do navegador.",
        });
        return;
      }

      const registration = await registerServiceWorker();
      if (!registration) throw new Error("service worker indisponível");

      const pushReady = await fetchPushConfig();
      if (pushReady) {
        const subscription = await getPushSubscription();
        if (!subscription) throw new Error("não foi possível criar a assinatura push");
        alerts.subscription = subscription.toJSON ? subscription.toJSON() : subscription;
        alerts.mode = "push";
        alerts.enabled = true;
        alerts.nick = state.currentNick;
        alerts.boundToBackend = false;
        alertsSaveSettings();
        const sent = await sendAlertStart(state.currentNick);
        if (!sent) throw new Error("sem conexão com o servidor");
        await showLocalNotification(
          "Ativando alertas",
          `Avisos de ${state.currentNick} serão enviados pelo navegador.`
        );
        alertLogAdd(`Ativando alertas para @${state.currentNick}`);
      } else {
        alerts.mode = "local";
        alerts.enabled = true;
        alerts.nick = state.currentNick;
        alerts.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
        alerts.boundToBackend = false;
        alertsSaveSettings();
        await showLocalNotification(
          "Alertas locais ativados",
          "Mantenha esta aba aberta em segundo plano para receber os avisos."
        );
        alertLogAdd(`Alertas locais ativados para @${state.currentNick}`);
        toast("Alertas locais ativados", {
          kind: "success",
          detail: "Mantenha a aba aberta (pode minimizar).",
        });
      }
    } catch (error) {
      alerts.enabled = false;
      alerts.mode = "";
      alerts.boundToBackend = false;
      alerts.busy = false;
      alertsSaveSettings();
      toast("Falha ao ativar alertas", {
        kind: "danger",
        detail: error?.message || String(error),
      });
    } finally {
      alerts.busy = false;
      alertsRender();
    }
  }

  async function disableAlerts({ silent = false } = {}) {
    const endpoint = alerts.subscription?.endpoint || "";
    if (endpoint) {
      await wsSendWhenOpen({ type: "alert_stop", endpoint }, 3_000).catch(() => false);
    }
    try {
      const registration = alerts.registration || (await registerServiceWorker());
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {
      /* ignora */
    }

    alerts.enabled = false;
    alerts.mode = "";
    alerts.subscription = null;
    alerts.expiresAt = 0;
    alerts.nick = "";
    alerts.boundToBackend = false;
    alerts.busy = false;
    if (alerts.pendingTimer) {
      clearTimeout(alerts.pendingTimer);
      alerts.pendingTimer = null;
    }
    if (alerts.expiryTimer) {
      clearTimeout(alerts.expiryTimer);
      alerts.expiryTimer = null;
    }
    alertsSaveSettings();
    alertsRender();
    alertLogAdd("Alertas desativados");
    if (!silent) toast("Alertas desativados", { kind: "info" });
  }

  async function testAlerts() {
    if (alerts.busy) return;
    if (typeof Notification === "undefined") {
      toast("Este navegador não suporta notificações", { kind: "danger" });
      return;
    }
    let permission = Notification.permission;
    if (permission !== "granted") permission = await Notification.requestPermission();
    alerts.permission = permission;
    if (permission !== "granted") {
      toast("Permissão de notificação negada", { kind: "warn" });
      alertsRender();
      return;
    }
    const registration = await registerServiceWorker();
    if (!registration) {
      toast("Service worker indisponível", { kind: "danger" });
      return;
    }
    await showLocalNotification("Teste de alerta", "Se você está vendo isso, as notificações estão funcionando.");
    if (alerts.enabled && alerts.mode === "push" && alerts.subscription?.endpoint) {
      wsSend({ type: "alert_test", endpoint: alerts.subscription.endpoint });
    }
    toast("Teste enviado", { kind: "success", detail: "Veja a notificação do navegador." });
  }

  async function initAlerts() {
    alerts.permission = typeof Notification !== "undefined" ? Notification.permission : "unsupported";
    alertsLoadSettings();
    await fetchPushConfig().catch(() => false);

    if (alerts.enabled && alerts.expiresAt && alerts.expiresAt < Date.now()) {
      alerts.enabled = false;
      alerts.mode = "";
      alerts.subscription = null;
      alerts.expiresAt = 0;
      alerts.nick = "";
    }
    if (alerts.enabled && alerts.permission === "denied") {
      alerts.enabled = false;
      alerts.mode = "";
      alerts.subscription = null;
    }

    const registration = await registerServiceWorker();
    if (registration && alerts.enabled && alerts.mode === "push") {
      try {
        alerts.publicKey = "";
        await fetchPushConfig();
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription) {
          alerts.subscription = subscription.toJSON ? subscription.toJSON() : subscription;
        } else {
          alerts.enabled = false;
          alerts.mode = "";
          alerts.subscription = null;
        }
      } catch {
        alerts.enabled = false;
        alerts.mode = "";
        alerts.subscription = null;
      }
    }

    alertsSaveSettings();
    alertsRender();
    scheduleAlertExpiry();
  }

  // ---------------- mensagens do backend ----------------

  function handleMessage(message) {
    switch (message.type) {
      case "hello":
        state.serverStatus = message.status || null;
        break;

      case "watching":
        state.target = message.target || null;
        if (!state.watchStartedAt) state.watchStartedAt = Date.now();
        els.stopBtn?.classList.remove("hidden");
        if (els.watchBtn) {
          els.watchBtn.disabled = false;
          els.watchBtn.textContent = "Vigiar";
        }
        renderTarget();
        alertsRender();
        if (
          alerts.enabled &&
          alerts.mode === "push" &&
          alerts.subscription?.endpoint &&
          (!alerts.boundToBackend || alerts.nick !== (message.nick || state.currentNick))
        ) {
          sendAlertStart(message.nick || state.currentNick).catch(() => {});
        }
        break;

      case "status":
        state.status = message.state || "idle";
        state.statusText = message.message || state.statusText;
        if (message.target) state.target = message.target;
        if (!state.room) {
          setStatus(state.status, state.statusText);
          renderRoomsState();
        } else {
          setStatus(state.status, state.statusText);
        }
        renderTarget();
        break;

      case "room": {
        const previousRoomId = state.room?.roomId || "";
        const nextRoomId = message.room?.roomId || "";
        if (previousRoomId && nextRoomId && previousRoomId !== nextRoomId) {
          toast("Mudou de sala", {
            kind: "info",
            detail: `${state.room?.name || previousRoomId} → ${message.room?.name || nextRoomId}`,
          });
        }
        state.room = message.room || null;
        state.occupants = Array.isArray(message.occupants) ? message.occupants : [];
        if (message.target) state.target = message.target;
        renderTarget();
        renderRoom();
        renderOccupants();
        setStatus("online", message.room ? `Na sala ${message.room.name}` : "Na sala");
        if (message.room) {
          const roomLabel = `${message.room.name || message.room.roomId}${
            message.room.privacy === "private" ? " (privada)" : ""
          }`;
          alertsLogAdd(`Sala: ${roomLabel}`);
          maybeLocalNotify(
            "IMVU Radar",
            `${state.target?.displayName || state.target?.username || "Alvo"} • ${roomLabel}`
          );
        }
        break;
      }

      case "offline":
        state.room = null;
        state.occupants = [];
        renderRoom();
        renderOccupants();
        setStatus("offline", message.message || "Sem sala no momento");
        break;

      case "room_leave": {
        const roomName = message.room?.name || message.room?.roomId || "sala";
        state.room = null;
        state.occupants = [];
        renderRoom();
        renderOccupants();
        setStatus("offline", "Fora de sala — monitorando...");
        toast(`${message.nick || state.target?.username || "O alvo"} saiu da sala`, {
          kind: "warn",
          detail: roomName,
        });
        alertsLogAdd(`Saiu de ${roomName}`);
        maybeLocalNotify("IMVU Radar", `${message.nick || "Alvo"} saiu de ${roomName}`);
        break;
      }

      case "occupant_join": {
        const person = message.occupant;
        if (person?.cid) {
          const exists = state.occupants.some((item) => item.cid === person.cid);
          if (!exists) state.occupants.push(person);
          renderOccupants();
        }
        const name = person?.displayName || person?.username || message.nick || "Alguém";
        toast(`${name} entrou na sala`, {
          kind: "success",
          detail: person?.username ? `@${person.username} · ${timeOf(message.at)}` : timeOf(message.at),
        });
        alertsLogAdd(`${name} entrou na sala`);
        maybeLocalNotify("IMVU Radar", `${name} entrou na sala`);
        break;
      }

      case "occupant_leave": {
        const cid = message.cid || message.occupant?.cid;
        if (cid) {
          state.occupants = state.occupants.filter((item) => item.cid !== cid);
          renderOccupants();
        }
        const name =
          message.occupant?.displayName ||
          message.occupant?.username ||
          message.nickOut ||
          message.nick ||
          "Alguém";
        toast(`${name} saiu da sala`, {
          kind: "danger",
          detail: message.occupant?.username ? `@${message.occupant.username} · ${timeOf(message.at)}` : timeOf(message.at),
        });
        alertsLogAdd(`${name} saiu da sala`);
        maybeLocalNotify("IMVU Radar", `${name} saiu da sala`);
        break;
      }

      case "error":
        setStatus("error", message.message || "Erro no rastreamento");
        renderRoomsState();
        toast(message.message || "Erro no rastreamento", { kind: "danger", detail: message.code || "" });
        if (["capacity", "nick_not_found", "invalid_nick", "login_failed", "rate_limit"].includes(message.code)) {
          state.watching = false;
          els.stopBtn?.classList.add("hidden");
        }
        if (els.watchBtn) {
          els.watchBtn.disabled = false;
          els.watchBtn.textContent = "Vigiar";
        }
        break;

      case "stopped":
        state.watching = false;
        state.currentNick = "";
        resetToIdle();
        break;

      case "alert_active": {
        if (alerts.pendingTimer) {
          clearTimeout(alerts.pendingTimer);
          alerts.pendingTimer = null;
        }
        alerts.enabled = true;
        alerts.mode = message.mode || "push";
        alerts.expiresAt = Number(message.expiresAt) || 0;
        alerts.nick = message.nick || state.currentNick;
        alerts.boundToBackend = true;
        alerts.busy = false;
        alertsSaveSettings();
        scheduleAlertExpiry();
        alertsRender();
        toast("Alertas ativados", {
          kind: "success",
          detail: alerts.expiresAt ? `Até ${timeOf(alerts.expiresAt)}` : "",
        });
        alertLogAdd(`Alertas ativos para @${alerts.nick}`);
        break;
      }

      case "alert_stopped":
        alerts.enabled = false;
        alerts.mode = "";
        alerts.subscription = null;
        alerts.expiresAt = 0;
        alerts.nick = "";
        alerts.boundToBackend = false;
        alerts.busy = false;
        if (alerts.pendingTimer) {
          clearTimeout(alerts.pendingTimer);
          alerts.pendingTimer = null;
        }
        alertsSaveSettings();
        alertsRender();
        break;

      case "alert_error":
        alerts.busy = false;
        alerts.boundToBackend = false;
        alerts.enabled = false;
        alerts.mode = "";
        alerts.expiresAt = 0;
        alerts.nick = "";
        if (alerts.pendingTimer) {
          clearTimeout(alerts.pendingTimer);
          alerts.pendingTimer = null;
        }
        alertsSaveSettings();
        alertsRender();
        toast(message.message || "Falha nos alertas", {
          kind: "danger",
          detail: message.code || "",
        });
        alertLogAdd(message.message || "Falha nos alertas");
        break;

      case "pong":
        break;

      default:
        break;
    }
  }

  // ---------------- render: alvo ----------------

  function appendInitials(container, person) {
    const span = document.createElement("span");
    span.className = "avatar-initials";
    span.textContent = initialsOf(person);
    container.appendChild(span);
  }

  function createAvatar(person, className) {
    const wrap = document.createElement("div");
    wrap.className = className;
    const url = proxiedImage(
      person?.avatarPortrait || person?.portrait || person?.avatar || person?.render
    );
    if (url) {
      const img = document.createElement("img");
      img.alt = person?.displayName || person?.username || "avatar";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener(
        "error",
        () => {
          img.remove();
          appendInitials(wrap, person);
        },
        { once: true }
      );
      img.src = url;
      wrap.appendChild(img);
    } else {
      appendInitials(wrap, person);
    }
    return wrap;
  }

  function makeBadge(text, kind) {
    const span = document.createElement("span");
    span.className = `tag ${kind}`;
    span.textContent = text;
    return span;
  }

  function renderTarget() {
    const target = state.target;
    if (!target) {
      els.targetEmpty?.classList.remove("hidden");
      els.targetContent?.classList.add("hidden");
      els.targetBadges?.replaceChildren();
      return;
    }

    els.targetEmpty?.classList.add("hidden");
    els.targetContent?.classList.remove("hidden");

    if (els.targetAvatar && els.targetAvatar.dataset.cid !== String(target.cid || "")) {
      els.targetAvatar.replaceChildren();
      const avatar = createAvatar(target, "avatar-xl");
      // createAvatar devolve a propria div; move o conteudo para o container fixo.
      while (avatar.firstChild) els.targetAvatar.appendChild(avatar.firstChild);
      els.targetAvatar.dataset.cid = String(target.cid || "");
    }
    if (els.targetName) els.targetName.textContent = target.displayName || target.username || "—";
    if (els.targetUser) els.targetUser.textContent = `@${target.username || "—"}`;
    if (els.targetCid) els.targetCid.textContent = `cid ${target.cid || "—"}`;
    if (els.targetOnline) els.targetOnline.textContent = target.online ? "online" : "offline";
    if (els.targetSince) els.targetSince.textContent = state.watchStartedAt ? `${timeOf(state.watchStartedAt)}` : "agora";

    if (els.targetBadges) {
      els.targetBadges.replaceChildren();
      els.targetBadges.appendChild(makeBadge(target.online ? "online" : "offline", target.online ? "tag-online" : "tag-offline"));
      if (target.isVip) els.targetBadges.appendChild(makeBadge("VIP", "tag-vip"));
      if (target.isAp) els.targetBadges.appendChild(makeBadge("AP", "tag-ap"));
    }

    document.title = `${target.displayName || target.username || "Nick"} — IMVU Radar`;
  }

  // ---------------- render: sala ----------------

  function setRoomEmptyDefaults() {
    if (els.roomEmptyTitle) els.roomEmptyTitle.textContent = "Nenhuma sala ainda";
    if (els.roomEmptyText) {
      els.roomEmptyText.textContent = "Quando o alvo entrar em uma sala, o nome, a privacidade e os ocupantes aparecem aqui.";
    }
  }

  function renderRoomsState() {
    if (state.room) {
      renderRoom();
      return;
    }
    if (state.status === "loading") {
      if (els.roomEmptyTitle) els.roomEmptyTitle.textContent = "Procurando sala...";
      if (els.roomEmptyText) {
        els.roomEmptyText.textContent = "Lendo listas oficiais, salas do alvo e canais do IMQ em tempo real.";
      }
    } else if (state.status === "offline") {
      if (els.roomEmptyTitle) els.roomEmptyTitle.textContent = "Fora de sala";
      if (els.roomEmptyText) {
        els.roomEmptyText.textContent = "O alvo não está em nenhuma sala agora. O radar continua ligado e avisa quando mudar.";
      }
    } else if (state.status === "error") {
      if (els.roomEmptyTitle) els.roomEmptyTitle.textContent = "Não foi possível rastrear";
      if (els.roomEmptyText) els.roomEmptyText.textContent = state.statusText || "Confira o nick e tente novamente.";
    } else {
      setRoomEmptyDefaults();
      if (els.roomEmptyText) {
        els.roomEmptyText.textContent = "Quando o alvo entrar em uma sala, o nome, a privacidade e os ocupantes aparecem aqui.";
      }
    }
  }

  function renderRoom() {
    const room = state.room;
    if (!room) {
      els.roomEmpty?.classList.remove("hidden");
      els.roomContent?.classList.add("hidden");
      if (els.roomBackdrop) {
        els.roomBackdrop.style.backgroundImage = "";
        els.roomBackdrop.style.opacity = "0";
      }
      renderRoomsState();
      return;
    }

    els.roomEmpty?.classList.add("hidden");
    els.roomContent?.classList.remove("hidden");

    if (els.roomName) els.roomName.textContent = room.name || room.roomId || "—";

    const isPrivate = room.privacy === "private" || room.privacyLabel === "Privada";
    if (els.roomPrivacy) {
      els.roomPrivacy.className = `tag ${isPrivate ? "tag-private" : "tag-public"}`;
      els.roomPrivacy.textContent = isPrivate ? "Privada" : "Pública";
    }

    if (els.roomId) els.roomId.textContent = room.roomId ? `#${room.roomId}` : "—";
    if (els.roomOwner) els.roomOwner.textContent = room.owner ? `dono ${room.owner}` : "dono —";
    if (els.roomOccupancy) {
      const capacity = Number(room.capacity) > 0 ? ` · cap. ${room.capacity}` : "";
      els.roomOccupancy.textContent = `${state.occupants.length} na sala${capacity}`;
    }

    const directLink = String(room.directLink || "").trim();
    const webLink = String(room.webLink || "").trim();

    if (els.roomImvuLink) {
      els.roomImvuLink.href = directLink || webLink || "#";
      const disabled = !directLink && !webLink;
      els.roomImvuLink.setAttribute("aria-disabled", disabled ? "true" : "false");
      els.roomImvuLink.classList.toggle("hidden", disabled);
    }
    if (els.roomWebLink) {
      els.roomWebLink.href = webLink || "#";
      els.roomWebLink.classList.toggle("hidden", !webLink);
    }
    if (els.roomDirect) {
      els.roomDirect.textContent = directLink ? readableLink(directLink) : webLink || "—";
    }
    if (els.copyRoomBtn) {
      els.copyRoomBtn.dataset.link = directLink || webLink || "";
      els.copyRoomBtn.disabled = !(directLink || webLink);
    }

    const backdrop = proxiedImage(room.cover || room.render || "");
    if (els.roomBackdrop) {
      if (backdrop) {
        els.roomBackdrop.style.backgroundImage = `url(${JSON.stringify(backdrop)})`;
        els.roomBackdrop.style.opacity = "0.14";
      } else {
        els.roomBackdrop.style.backgroundImage = "";
        els.roomBackdrop.style.opacity = "0";
      }
    }

    if (state.target) {
      document.title = `${state.target.displayName || state.target.username} em ${room.name} — IMVU Radar`;
    }
  }

  function renderOccupants() {
    if (!els.occupants) return;
    els.occupants.replaceChildren();

    const total = state.occupants.length;
    if (els.occupantCount) els.occupantCount.textContent = String(total);
    if (els.occupantHint) {
      els.occupantHint.textContent = state.room
        ? "atualiza sozinho via IMQ"
        : "os avatares aparecem aqui em tempo real";
    }

    if (!total) {
      const empty = document.createElement("div");
      empty.className =
        "col-span-full rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-slate-500";
      empty.textContent = state.room ? "Ninguém visível na sala." : "Ninguém para mostrar ainda.";
      els.occupants.appendChild(empty);
      return;
    }

    const targetCid = state.target?.cid;
    const sorted = [...state.occupants].sort((a, b) => {
      if (a.cid === targetCid) return -1;
      if (b.cid === targetCid) return 1;
      return String(a.displayName || a.username || "").localeCompare(String(b.displayName || b.username || ""), "pt-BR");
    });

    for (const person of sorted) {
      const card = document.createElement("div");
      card.className = `occupant-card${person.cid === targetCid ? " is-target" : ""}`;
      card.title = "Clique para copiar o nick";
      card.dataset.cid = person.cid || "";

      const avatar = createAvatar(person, "occupant-avatar");
      card.appendChild(avatar);

      const body = document.createElement("div");
      body.className = "min-w-0 flex-1";
      const name = document.createElement("div");
      name.className = "occupant-name";
      name.textContent = person.displayName || person.username || person.nick || "—";
      const user = document.createElement("div");
      user.className = "occupant-user";
      user.textContent = `@${person.username || person.nick || "—"}`;
      body.append(name, user);
      card.appendChild(body);

      if (person.isVip) {
        const vip = document.createElement("span");
        vip.className = "vip-badge";
        vip.textContent = "VIP";
        card.appendChild(vip);
      }

      card.addEventListener("click", () => {
        copyText(person.username || person.nick || "", "Nick copiado");
      });

      els.occupants.appendChild(card);
    }
  }

  // ---------------- status / toasts ----------------

  function setStatus(kind, message) {
    state.status = kind;
    state.statusText = message || state.statusText;
    const map = {
      idle: "room-status status-idle",
      loading: "room-status status-loading",
      online: "room-status status-online",
      offline: "room-status status-offline",
      error: "room-status status-error",
    };
    setClass(els.roomStatus, map[kind] || map.idle);
    if (els.roomStatusText) els.roomStatusText.textContent = message || "Aguardando";
  }

  function dismissToast(element) {
    if (!element || element.classList.contains("is-leaving")) return;
    element.classList.add("is-leaving");
    setTimeout(() => element.remove(), 240);
  }

  function toast(title, { kind = "info", detail = "", timeout = 5000 } = {}) {
    if (!els.toasts) return;
    while (els.toasts.children.length >= 4) {
      els.toasts.firstElementChild?.remove();
    }

    const icons = { success: "+", danger: "−", warn: "!", info: "i" };
    const element = document.createElement("div");
    element.className = `toast toast-${kind}`;

    const icon = document.createElement("div");
    icon.className = "toast-icon";
    icon.textContent = icons[kind] || "i";

    const body = document.createElement("div");
    body.className = "toast-body";
    const titleEl = document.createElement("div");
    titleEl.className = "toast-title";
    titleEl.textContent = title;
    body.appendChild(titleEl);
    if (detail) {
      const detailEl = document.createElement("div");
      detailEl.className = "toast-detail";
      detailEl.textContent = detail;
      body.appendChild(detailEl);
    }

    const close = document.createElement("button");
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", "Fechar");
    close.textContent = "×";
    close.addEventListener("click", () => dismissToast(element));

    element.append(icon, body, close);
    els.toasts.appendChild(element);

    let timer = setTimeout(() => dismissToast(element), timeout);
    element.addEventListener("mouseenter", () => clearTimeout(timer));
    element.addEventListener("mouseleave", () => {
      timer = setTimeout(() => dismissToast(element), 2_500);
    });
  }

  async function copyText(text, successMessage = "Copiado") {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      toast(successMessage, { kind: "info", detail: text, timeout: 2500 });
    } catch {
      toast("Não foi possível copiar", { kind: "warn", detail: text, timeout: 3000 });
    }
  }

  // ---------------- estados da UI ----------------

  function resetToIdle() {
    state.target = null;
    state.room = null;
    state.occupants = [];
    state.status = "idle";
    state.statusText = "Aguardando";
    state.watchStartedAt = 0;
    els.stopBtn?.classList.add("hidden");
    if (els.targetBadges) els.targetBadges.replaceChildren();
    els.targetEmpty?.classList.remove("hidden");
    els.targetContent?.classList.add("hidden");
    if (els.targetEmptyTitle) els.targetEmptyTitle.textContent = "Nenhum nick ainda";
    if (els.targetEmptyText) {
      els.targetEmptyText.textContent = "Digite um nick acima e clique em Vigiar para começar a monitorar.";
    }
    if (els.targetEmptyAvatar) els.targetEmptyAvatar.textContent = "?";
    renderRoom();
    renderOccupants();
    setStatus("idle", "Aguardando");
    document.title = "IMVU Radar — presença em tempo real";
    alertsRender();
  }

  function resetForWatch(nick) {
    state.target = null;
    state.room = null;
    state.occupants = [];
    state.status = "loading";
    state.statusText = "Conectando...";
    state.watchStartedAt = Date.now();
    els.stopBtn?.classList.remove("hidden");
    els.targetEmpty?.classList.remove("hidden");
    els.targetContent?.classList.add("hidden");
    if (els.targetEmptyAvatar) els.targetEmptyAvatar.textContent = initialsOf({ username: nick });
    if (els.targetEmptyTitle) els.targetEmptyTitle.textContent = `Buscando ${nick}...`;
    if (els.targetEmptyText) els.targetEmptyText.textContent = "Resolvendo o nick e abrindo o canal do IMQ.";
    renderRoom();
    renderOccupants();
    setStatus("loading", "Conectando...");
    if (els.watchBtn) {
      els.watchBtn.disabled = true;
      els.watchBtn.textContent = "Buscando...";
    }
    alertsRender();
  }

  // ---------------- eventos ----------------

  els.watchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const nick = String(els.nickInput?.value || "")
      .replace(/^@+/, "")
      .trim()
      .slice(0, 64);

    if (!nick) {
      els.watchForm.querySelector(".search-box")?.classList.add("shake");
      setTimeout(() => document.querySelector(".search-box")?.classList.remove("shake"), 420);
      toast("Digite um nick", { kind: "warn", detail: "O nick é obrigatório para iniciar o rastreio." });
      els.nickInput?.focus();
      return;
    }

    state.currentNick = nick;
    state.watching = true;
    safeStorage.set("radar:nick", nick);
    resetForWatch(nick);

    if (!wsSend({ type: "watch", nick })) {
      connect();
    }
  });

  els.stopBtn?.addEventListener("click", () => {
    state.watching = false;
    state.currentNick = "";
    wsSend({ type: "stop" });
    if (alerts.enabled) disableAlerts({ silent: true }).catch(() => {});
    resetToIdle();
    toast("Monitoramento parado", { kind: "info", detail: "O radar não está mais vigiando esse nick." });
  });

  els.copyRoomBtn?.addEventListener("click", () => {
    copyText(els.copyRoomBtn.dataset.link || "", "Link copiado");
  });

  els.alertsBtn?.addEventListener("click", alertsOpen);
  els.closeAlertsBtn?.addEventListener("click", alertsClose);
  els.alertsOverlay?.addEventListener("click", alertsClose);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") alertsClose();
  });
  els.enableAlertsBtn?.addEventListener("click", enableAlerts);
  els.disableAlertsBtn?.addEventListener("click", () => disableAlerts());
  els.testAlertBtn?.addEventListener("click", testAlerts);
  els.alertOccupants?.addEventListener("change", () => {
    alerts.settings.occupants = Boolean(els.alertOccupants.checked);
    alertsSaveSettings();
    alertsRender();
    if (alerts.enabled && alerts.mode === "push" && alerts.subscription?.endpoint && state.currentNick) {
      sendAlertStart(state.currentNick).catch(() => {});
    }
  });

  // Enter no input já usa o form. Botão "Parar" fica oculto até vigiar.

  const savedNick = safeStorage.get("radar:nick");
  if (savedNick && els.nickInput && !els.nickInput.value) {
    els.nickInput.value = savedNick;
  }

  setConnection("connecting");
  resetToIdle();

  const initialNick = String(params.get("nick") || "")
    .replace(/^@+/, "")
    .trim()
    .slice(0, 64);
  if (initialNick) {
    if (els.nickInput) els.nickInput.value = initialNick;
    state.currentNick = initialNick;
    state.watching = true;
    safeStorage.set("radar:nick", initialNick);
    resetForWatch(initialNick);
  }

  connect();
  initAlerts().catch(() => {});

  setInterval(() => {
    if (state.connected) {
      wsSend({ type: "ping" });
    } else {
      connect();
    }
  }, 25_000);
})();

