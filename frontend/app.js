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
    rooms: [],
    occupants: [],
    locationHidden: false,
    locationHiddenTitle: "",
    locationHiddenText: "",
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

  const profileModal = {
    open: false,
    cid: "",
    requestId: 0,
    cache: new Map(),
  };

  const cinema = {
    open: false,
    roomId: "",
    room: null,
    panzoom: null,
    requestId: 0,
    chatCount: 0,
    occupants: new Map(),
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
    roomHidden: $("#roomHidden"),
    roomHiddenText: $("#roomHiddenText"),
    roomContent: $("#roomContent"),
    roomsList: $("#roomsList"),
    roomCountBadge: $("#roomCountBadge"),
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
    profileOverlay: $("#profileOverlay"),
    profileModal: $("#profileModal"),
    profileCloseBtn: $("#profileCloseBtn"),
    profileAvatar: $("#profileAvatar"),
    profileModalName: $("#profileModalName"),
    profileUsername: $("#profileUsername"),
    profileCid: $("#profileCid"),
    profileBadges: $("#profileBadges"),
    profileLoading: $("#profileLoading"),
    profileError: $("#profileError"),
    profileInfo: $("#profileInfo"),
    profileFollowers: $("#profileFollowers"),
    profileFollowing: $("#profileFollowing"),
    profileJoined: $("#profileJoined"),
    profileAge: $("#profileAge"),
    profileStatusBox: $("#profileStatusBox"),
    profileStatus: $("#profileStatus"),
    profileBioBox: $("#profileBioBox"),
    profileBio: $("#profileBio"),
    profileWebLink: $("#profileWebLink"),
    profileAppLink: $("#profileAppLink"),
    profileCopyBtn: $("#profileCopyBtn"),
    cinemaOverlay: $("#cinemaOverlay"),
    cinemaModal: $("#cinemaModal"),
    cinemaCloseBtn: $("#cinemaCloseBtn"),
    cinemaTitle: $("#cinemaTitle"),
    cinemaMeta: $("#cinemaMeta"),
    cinemaStatus: $("#cinemaStatus"),
    cinemaViewport: $("#cinemaViewport"),
    cinemaStage: $("#cinemaStage"),
    cinemaRoomImage: $("#cinemaRoomImage"),
    cinemaAvatars: $("#cinemaAvatars"),
    cinemaEmpty: $("#cinemaEmpty"),
    cinemaMessages: $("#cinemaMessages"),
    cinemaChatCount: $("#cinemaChatCount"),
    cinemaChatHint: $("#cinemaChatHint"),
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
      if (cinema.open && cinema.roomId) {
        wsSend({ type: "cinema_join", roomId: cinema.roomId });
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
        text = "Ativando alertas... aguarde até 30s";
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
      if (alerts.busy) {
        info = "Preparando a assinatura push. Pode levar até 30s...";
      } else if (alerts.enabled) {
        const monitored = alerts.nick || state.currentNick || "nick";
        info =
          alerts.mode === "push"
            ? `Monitorando @${monitored}. Pode fechar o site: o push continua.`
            : `Monitorando @${monitored}. Mantenha a aba aberta em segundo plano.`;
      } else if (!state.currentNick) {
        info = "Vigie um nick primeiro e ative os alertas.";
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
      await navigator.serviceWorker.ready.catch(() => {});
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

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
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
      let subscription = null;
      let pushError = null;
      if (pushReady) {
        try {
          subscription = await withTimeout(
            getPushSubscription(),
            30_000,
            "tempo esgotado ao criar a assinatura push"
          );
        } catch (error) {
          pushError = error;
          subscription = null;
          window.__radarPushError = String(error?.stack || error?.message || error);
          console.warn("[alerts] push falhou", error);
        }
      }

      if (subscription) {
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
          detail: pushError
            ? "Push indisponível agora; mantenha a aba aberta."
            : "Mantenha a aba aberta (pode minimizar).",
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

  // ---------------- modal de perfil ----------------

  const profileWebUrl = (username, cid) => {
    const key = String(username || cid || "").trim();
    return key ? `https://www.imvu.com/next/u/${encodeURIComponent(key)}/` : "";
  };

  const profileAppUrl = (username, cid) => {
    const key = String(username || cid || "").trim();
    return key ? `https://www.imvu.com/user/${encodeURIComponent(key)}/` : "";
  };

  const formatProfileNumber = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    return number.toLocaleString("pt-BR");
  };

  const formatProfileDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  };

  function renderProfileBadges(data) {
    if (!els.profileBadges) return;
    els.profileBadges.replaceChildren();
    const online = Boolean(data?.online);
    els.profileBadges.appendChild(makeBadge(online ? "online" : "offline", online ? "tag-online" : "tag-offline"));
    if (data?.isVip) els.profileBadges.appendChild(makeBadge("VIP", "tag-vip"));
    if (data?.isAp) els.profileBadges.appendChild(makeBadge("AP", "tag-ap"));
    if (data?.isAgeVerified || data?.isAdult) {
      els.profileBadges.appendChild(makeBadge("18+", "tag-adult"));
    }
  }

  function renderProfileAvatar(data) {
    if (!els.profileAvatar) return;
    els.profileAvatar.replaceChildren();
    const person = {
      displayName: data?.displayName || data?.username || "",
      username: data?.username || "",
      avatar: data?.avatar || "",
      avatarPortrait: data?.avatar || data?.portrait || "",
      portrait: data?.portrait || "",
    };
    const avatar = createAvatar(person, "profile-avatar");
    while (avatar.firstChild) els.profileAvatar.appendChild(avatar.firstChild);
  }

  function renderProfile(profile, requestId) {
    if (!profileModal.open || requestId !== profileModal.requestId || !profile) return;
    els.profileLoading?.classList.add("hidden");
    els.profileError?.classList.add("hidden");

    if (els.profileModalName) els.profileModalName.textContent = profile.displayName || profile.username || profile.cid;
    if (els.profileUsername) els.profileUsername.textContent = `@${profile.username || profile.cid || "—"}`;
    if (els.profileCid) els.profileCid.textContent = `cid ${profile.cid || "—"}`;
    renderProfileBadges(profile);
    renderProfileAvatar(profile);

    if (els.profileFollowers) els.profileFollowers.textContent = formatProfileNumber(profile.followers);
    if (els.profileFollowing) els.profileFollowing.textContent = formatProfileNumber(profile.following);
    if (els.profileJoined) els.profileJoined.textContent = formatProfileDate(profile.joinedAt);
    if (els.profileAge) els.profileAge.textContent = profile.age ? `${profile.age} anos` : "—";

    if (els.profileStatusBox && els.profileStatus) {
      const status = String(profile.status || "").trim();
      els.profileStatus.textContent = status;
      els.profileStatusBox.classList.toggle("hidden", !status);
    }
    if (els.profileBioBox && els.profileBio) {
      const bio = String(profile.bio || "").trim();
      els.profileBio.textContent = bio;
      els.profileBioBox.classList.toggle("hidden", !bio);
    }

    const webUrl = profile.webUrl || profileWebUrl(profile.username, profile.cid);
    const appUrl = profile.appUrl || profileAppUrl(profile.username, profile.cid);
    if (els.profileWebLink) els.profileWebLink.href = webUrl || "#";
    if (els.profileAppLink) els.profileAppLink.href = appUrl || "#";
    if (els.profileCopyBtn) {
      els.profileCopyBtn.dataset.link = webUrl || "";
      els.profileCopyBtn.disabled = !webUrl;
    }

    els.profileInfo?.classList.remove("hidden");
  }

  function openProfileModal() {
    if (!els.profileModal || !els.profileOverlay) return;
    els.profileOverlay.classList.remove("hidden");
    els.profileModal.classList.remove("hidden");
    els.profileOverlay.setAttribute("aria-hidden", "false");
    els.profileModal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      els.profileModal.classList.add("is-open");
      els.profileOverlay.classList.add("is-open");
    });
    document.body.style.overflow = "hidden";
    setTimeout(() => els.profileCloseBtn?.focus?.(), 60);
  }

  function closeProfileModal() {
    if (!profileModal.open) return;
    profileModal.open = false;
    profileModal.cid = "";
    profileModal.requestId += 1;
    els.profileModal?.classList.remove("is-open");
    els.profileOverlay?.classList.remove("is-open");
    els.profileModal?.setAttribute("aria-hidden", "true");
    els.profileOverlay?.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (profileModal.open) return;
      els.profileModal?.classList.add("hidden");
      els.profileOverlay?.classList.add("hidden");
    }, 260);
    const alertsOpenNow = els.alertsPanel && !els.alertsPanel.classList.contains("hidden");
    document.body.style.overflow = alertsOpenNow ? "hidden" : "";
  }

  function openProfile(person) {
    if (!person?.cid) return;
    const cid = String(person.cid);
    const requestId = profileModal.requestId + 1;
    profileModal.requestId = requestId;
    profileModal.open = true;
    profileModal.cid = cid;

    if (els.profileModalName) els.profileModalName.textContent = person.displayName || person.username || cid;
    if (els.profileUsername) els.profileUsername.textContent = `@${person.username || cid}`;
    if (els.profileCid) els.profileCid.textContent = `cid ${cid}`;
    renderProfileBadges(person);
    renderProfileAvatar(person);

    if (els.profileFollowers) els.profileFollowers.textContent = "—";
    if (els.profileFollowing) els.profileFollowing.textContent = "—";
    if (els.profileJoined) els.profileJoined.textContent = "—";
    if (els.profileAge) els.profileAge.textContent = "—";
    els.profileInfo?.classList.add("hidden");
    els.profileError?.classList.add("hidden");
    if (els.profileError) els.profileError.textContent = "";
    els.profileLoading?.classList.remove("hidden");
    if (els.profileLoading) els.profileLoading.textContent = "Carregando perfil...";

    const webUrl = profileWebUrl(person.username, cid);
    const appUrl = profileAppUrl(person.username, cid);
    if (els.profileWebLink) els.profileWebLink.href = webUrl || "#";
    if (els.profileAppLink) els.profileAppLink.href = appUrl || "#";
    if (els.profileCopyBtn) {
      els.profileCopyBtn.dataset.link = webUrl || "";
      els.profileCopyBtn.disabled = !webUrl;
    }

    openProfileModal();

    const cached = profileModal.cache.get(cid);
    if (cached && Date.now() - cached.at < 120_000) {
      renderProfile(cached.profile, requestId);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    fetch(`${HTTP_BASE}/api/perfil/${encodeURIComponent(cid)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json?.ok || !json.profile) {
          throw new Error(json?.error || "Perfil indisponível no momento.");
        }
        profileModal.cache.set(cid, { at: Date.now(), profile: json.profile });
        renderProfile(json.profile, requestId);
      })
      .catch((error) => {
        if (!profileModal.open || requestId !== profileModal.requestId) return;
        els.profileLoading?.classList.add("hidden");
        if (els.profileError) {
          els.profileError.textContent =
            error?.name === "AbortError"
              ? "O IMVU demorou para responder. Tente novamente."
              : error?.message || "Não foi possível carregar o perfil.";
          els.profileError.classList.remove("hidden");
        }
      })
      .finally(() => clearTimeout(timer));
  }

  // ---------------- modo cinema ----------------

  function cinemaBotCid() {
    return String(state.serverStatus?.botCid || "");
  }

  function setCinemaStatus(text, kind = "") {
    if (!els.cinemaStatus) return;
    els.cinemaStatus.textContent = text;
    els.cinemaStatus.className = `cinema-status${kind ? ` is-${kind}` : ""}`;
  }

  function setCinemaRoomImage(raw) {
    const url = proxiedImage(raw);
    if (els.cinemaRoomImage) {
      if (url) {
        els.cinemaRoomImage.style.display = "";
        if (els.cinemaRoomImage.src !== url) els.cinemaRoomImage.src = url;
      } else {
        els.cinemaRoomImage.removeAttribute("src");
        els.cinemaRoomImage.style.display = "none";
      }
    }
    els.cinemaEmpty?.classList.toggle("hidden", Boolean(url));
  }

  function resetCinemaMessages(text) {
    if (!els.cinemaMessages) return;
    els.cinemaMessages.replaceChildren();
    const empty = document.createElement("div");
    empty.id = "cinemaChatEmpty";
    empty.className = "cinema-chat-empty";
    empty.textContent = text || "Conectando ao chat...";
    els.cinemaMessages.appendChild(empty);
  }

  function appendCinemaChat(message) {
    if (!els.cinemaMessages || !message) return;
    const empty = els.cinemaMessages.querySelector(".cinema-chat-empty");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = `cinema-message${message.action ? " is-action" : ""}`;
    const time = document.createElement("span");
    time.className = "cinema-msg-time";
    time.textContent = message.horario || timeOf(message.at);
    const nick = document.createElement("span");
    nick.className = "cinema-msg-nick";
    nick.textContent = message.nick || "Alguém";
    const text = document.createElement("span");
    text.className = "cinema-msg-text";
    text.textContent = message.mensagem || "";
    item.append(time, nick, text);

    const nearBottom =
      els.cinemaMessages.scrollHeight - els.cinemaMessages.scrollTop - els.cinemaMessages.clientHeight < 90;
    els.cinemaMessages.appendChild(item);
    while (els.cinemaMessages.querySelectorAll(".cinema-message").length > 120) {
      els.cinemaMessages.querySelector(".cinema-message")?.remove();
    }
    cinema.chatCount += 1;
    if (els.cinemaChatCount) els.cinemaChatCount.textContent = String(cinema.chatCount);
    if (nearBottom) els.cinemaMessages.scrollTop = els.cinemaMessages.scrollHeight;
  }

  function removeCinemaOccupant(cid) {
    const id = String(cid || "");
    if (!id || !els.cinemaAvatars) return;
    cinema.occupants.delete(id);
    for (const child of [...els.cinemaAvatars.children]) {
      if (child.dataset.cid === id) child.remove();
    }
  }

  function appendCinemaAvatar(occupant) {
    if (!occupant?.cid || !els.cinemaAvatars) return;
    const cid = String(occupant.cid);
    const botCid = cinemaBotCid();
    if (botCid && cid === botCid) return;
    const existing = [...els.cinemaAvatars.children].find((child) => child.dataset.cid === cid);
    cinema.occupants.set(cid, occupant);
    if (existing) return;

    const marker = document.createElement("div");
    marker.className = "cinema-avatar";
    marker.dataset.cid = cid;
    marker.title = occupant.displayName || occupant.username || cid;

    const url = proxiedImage(
      occupant.lookThumbnail || occupant.lookImage || occupant.avatar || occupant.portrait || ""
    );
    const addFallback = () => {
      const fallback = document.createElement("span");
      fallback.className = "cinema-avatar-fallback";
      fallback.textContent = initialsOf(occupant);
      marker.insertBefore(fallback, marker.firstChild);
    };
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = occupant.displayName || occupant.username || "avatar";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener(
        "error",
        () => {
          img.remove();
          addFallback();
        },
        { once: true }
      );
      marker.appendChild(img);
    } else {
      addFallback();
    }

    const name = document.createElement("span");
    name.className = "cinema-avatar-name";
    name.textContent = occupant.displayName || occupant.username || cid;
    marker.appendChild(name);
    els.cinemaAvatars.appendChild(marker);
  }

  function renderCinemaOccupants(occupants) {
    if (!els.cinemaAvatars) return;
    cinema.occupants.clear();
    els.cinemaAvatars.replaceChildren();
    for (const occupant of occupants || []) appendCinemaAvatar(occupant);
  }

  function startCinemaPanzoom() {
    stopCinemaPanzoom();
    if (typeof window.panzoom !== "function" || !els.cinemaStage) return;
    try {
      cinema.panzoom = window.panzoom(els.cinemaStage, {
        maxZoom: 4,
        minZoom: 0.8,
        bounds: true,
        boundsPadding: 0.1,
        smoothScroll: false,
      });
    } catch {
      cinema.panzoom = null;
    }
  }

  function stopCinemaPanzoom() {
    try {
      cinema.panzoom?.dispose?.();
    } catch {
      /* ignora */
    }
    cinema.panzoom = null;
  }

  function openCinema(room) {
    if (!room?.roomId) return;
    cinema.open = true;
    cinema.roomId = String(room.roomId);
    cinema.room = room;
    cinema.chatCount = 0;
    const requestId = cinema.requestId + 1;
    cinema.requestId = requestId;

    if (els.cinemaTitle) els.cinemaTitle.textContent = roomDisplayName(room);
    if (els.cinemaMeta) {
      els.cinemaMeta.textContent = `#${room.roomId} · ${
        roomTypeOf(room) === "PRIVATE" ? "privada" : "pública"
      } · ${(room.occupants || []).length || room.total || 0} na sala`;
    }
    setCinemaStatus("conectando...", "");
    if (els.cinemaChatCount) els.cinemaChatCount.textContent = "0";
    resetCinemaMessages("Iniciando observador invisível...");
    if (els.cinemaChatHint) els.cinemaChatHint.textContent = "O bot observa sem entrar na sala.";
    setCinemaRoomImage(room.image || room.render || room.cover || room.thumbnail || "");
    renderCinemaOccupants(room.occupants || (state.room?.roomId === room.roomId ? state.occupants : []));

    els.cinemaOverlay?.classList.remove("hidden");
    els.cinemaModal?.classList.remove("hidden");
    els.cinemaOverlay?.setAttribute("aria-hidden", "false");
    els.cinemaModal?.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      els.cinemaModal?.classList.add("is-open");
      els.cinemaOverlay?.classList.add("is-open");
    });
    document.body.style.overflow = "hidden";
    setTimeout(startCinemaPanzoom, 80);

    fetch(`${HTTP_BASE}/api/sala-2d/${encodeURIComponent(room.roomId)}`, { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json?.ok || !json.room) {
          throw new Error(json?.error || "Sala indisponível no momento.");
        }
        if (!cinema.open || requestId !== cinema.requestId) return;
        const data = json.room;
        cinema.room = data;
        if (els.cinemaTitle) els.cinemaTitle.textContent = data.name || roomDisplayName(room);
        if (els.cinemaMeta) {
          els.cinemaMeta.textContent = `#${data.roomId} · ${data.privacyLabel || "—"} · ${data.occupancy || 0} na sala`;
        }
        setCinemaRoomImage(data.image || data.thumbnail || "");
        renderCinemaOccupants(data.occupants || []);
        if (!data.chat) {
          setCinemaStatus("sem chat clássico", "warn");
          if (els.cinemaChatHint) els.cinemaChatHint.textContent = "Esta sala não tem chat clássico.";
        }
      })
      .catch((error) => {
        if (!cinema.open || requestId !== cinema.requestId) return;
        setCinemaStatus("imagem indisponível", "warn");
        if (els.cinemaChatHint) els.cinemaChatHint.textContent = error?.message || "Não foi possível carregar a sala 2D.";
      });

    if (!wsSend({ type: "cinema_join", roomId: cinema.roomId })) {
      connect();
    }
  }

  function closeCinema() {
    if (!cinema.open) return;
    const roomId = cinema.roomId;
    cinema.open = false;
    cinema.roomId = "";
    cinema.room = null;
    cinema.requestId += 1;
    cinema.occupants.clear();
    stopCinemaPanzoom();
    wsSend({ type: "cinema_leave", roomId });
    els.cinemaModal?.classList.remove("is-open");
    els.cinemaOverlay?.classList.remove("is-open");
    els.cinemaModal?.setAttribute("aria-hidden", "true");
    els.cinemaOverlay?.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (cinema.open) return;
      els.cinemaModal?.classList.add("hidden");
      els.cinemaOverlay?.classList.add("hidden");
    }, 240);
    const otherOpen =
      (els.alertsPanel && !els.alertsPanel.classList.contains("hidden")) || profileModal.open;
    document.body.style.overflow = otherOpen ? "hidden" : "";
  }

  // ---------------- mensagens do backend ----------------

  function handleMessage(message) {
    switch (message.type) {
      case "hello":
        state.serverStatus = message.status || null;
        break;

      case "watching":
        state.target = message.target || null;
        state.locationHidden = false;
        state.locationHiddenTitle = "";
        state.locationHiddenText = "";
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
        state.locationHidden = false;
        state.locationHiddenTitle = "";
        state.locationHiddenText = "";
        const previousRoomId = state.room?.roomId || "";
        const rooms = normalizeRooms(message);
        const primaryId = String(message.room?.roomId || rooms[0]?.roomId || "");
        const primary = rooms.find((room) => room.roomId === primaryId) || rooms[0] || null;
        if (previousRoomId && primary?.roomId && previousRoomId !== primary.roomId) {
          toast("Mudou de sala", {
            kind: "info",
            detail: `${roomDisplayName(state.room)} → ${roomDisplayName(primary)}`,
          });
        }
        state.rooms = rooms;
        state.room = primary;
        state.occupants = primary?.occupants?.length
          ? primary.occupants
          : Array.isArray(message.occupants)
            ? message.occupants
            : [];
        if (message.target) state.target = message.target;
        renderTarget();
        renderRoom();
        renderOccupants();
        setStatus("online", primary ? `Na sala ${roomDisplayName(primary)}` : "Na sala");
        if (primary) {
          const roomLabel = `${roomDisplayName(primary)}${
            roomTypeOf(primary) === "PRIVATE" ? " (privada)" : ""
          }`;
          alertLogAdd(`Sala: ${roomLabel}`);
          maybeLocalNotify(
            "IMVU Radar",
            `${state.target?.displayName || state.target?.username || "Alvo"} • ${roomLabel}`
          );
        }
        break;
      }

      case "location_hidden":
        state.locationHidden = true;
        state.locationHiddenTitle = message.title || "Localização Indisponível";
        state.locationHiddenText = message.message || "";
        state.room = null;
        state.rooms = [];
        state.occupants = [];
        if (message.target) state.target = message.target;
        renderTarget();
        renderRoom();
        renderOccupants();
        setStatus("hidden", "Indisponível");
        break;

      case "offline":
        state.locationHidden = false;
        state.locationHiddenTitle = "";
        state.locationHiddenText = "";
        state.room = null;
        state.rooms = [];
        state.occupants = [];
        renderRoom();
        renderOccupants();
        setStatus("offline", message.message || "Sem sala no momento");
        break;

      case "room_leave": {
        state.locationHidden = false;
        state.locationHiddenTitle = "";
        state.locationHiddenText = "";
        const leftRoomId = String(message.room?.roomId || "");
        const roomName = roomDisplayName(message.room);
        if (leftRoomId) {
          state.rooms = state.rooms.filter((room) => room.roomId !== leftRoomId);
        }
        state.room = state.rooms[0] || null;
        state.occupants = state.room?.occupants || [];
        renderRoom();
        renderOccupants();
        if (!state.rooms.length) setStatus("offline", "Fora de sala — monitorando...");
        toast(`${message.nick || state.target?.username || "O alvo"} saiu da sala`, {
          kind: "warn",
          detail: roomName,
        });
        alertLogAdd(`Saiu de ${roomName}`);
        maybeLocalNotify("IMVU Radar", `${message.nick || "Alvo"} saiu de ${roomName}`);
        break;
      }

      case "occupant_join": {
        const person = message.occupant;
        if (person?.cid) {
          const roomId = String(message.room || state.room?.roomId || "");
          const room =
            state.rooms.find((item) => item.roomId === roomId) ||
            (state.room?.roomId === roomId ? state.room : null);
          if (room) {
            if (!Array.isArray(room.occupants)) room.occupants = [];
            if (!room.occupants.some((item) => item.cid === person.cid)) {
              room.occupants.push(person);
              room.total = room.occupants.length;
              room.occupancy = Math.max(Number(room.occupancy) || 0, room.occupants.length);
            }
            if (state.room?.roomId === roomId) state.occupants = room.occupants;
          }
          renderRoom();
          renderOccupants();
        }
        const name = person?.displayName || person?.username || message.nick || "Alguém";
        toast(`${name} entrou na sala`, {
          kind: "success",
          detail: person?.username ? `@${person.username} · ${timeOf(message.at)}` : timeOf(message.at),
        });
        alertLogAdd(`${name} entrou na sala`);
        maybeLocalNotify("IMVU Radar", `${name} entrou na sala`);
        break;
      }

      case "occupant_leave": {
        const cid = message.cid || message.occupant?.cid;
        if (cid) {
          const roomId = String(message.room || state.room?.roomId || "");
          const room =
            state.rooms.find((item) => item.roomId === roomId) ||
            (state.room?.roomId === roomId ? state.room : null);
          if (room && Array.isArray(room.occupants)) {
            room.occupants = room.occupants.filter((item) => item.cid !== cid);
            room.total = room.occupants.length;
            if (state.room?.roomId === roomId) state.occupants = room.occupants;
          }
          renderRoom();
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
        alertLogAdd(`${name} saiu da sala`);
        maybeLocalNotify("IMVU Radar", `${name} saiu da sala`);
        break;
      }

      case "cinema_ready":
        if (cinema.open && message.roomId === cinema.roomId) {
          setCinemaStatus(message.chat ? "chat ao vivo" : "sem chat clássico", message.chat ? "" : "warn");
          if (els.cinemaChatHint) {
            els.cinemaChatHint.textContent = message.chat
              ? "O bot observa sem entrar na sala."
              : "Esta sala não tem chat clássico.";
          }
          if (els.cinemaMessages) {
            const empty = els.cinemaMessages.querySelector(".cinema-chat-empty");
            if (empty) {
              empty.textContent = message.chat
                ? "Nenhuma mensagem ainda. O chat aparece aqui em tempo real."
                : "Esta sala não tem chat clássico.";
            }
          }
        }
        break;

      case "cinema_error":
        if (cinema.open && message.roomId === cinema.roomId) {
          setCinemaStatus("chat indisponível", "error");
          if (els.cinemaChatHint) els.cinemaChatHint.textContent = message.message || "Falha ao observar o chat.";
          appendCinemaChat({
            nick: "Radar",
            mensagem: message.message || "Falha ao observar o chat.",
            horario: timeOf(Date.now()),
          });
        }
        break;

      case "cinema_chat":
        if (cinema.open && message.roomId === cinema.roomId) appendCinemaChat(message);
        break;

      case "cinema_occupant_join":
        if (cinema.open && message.roomId === cinema.roomId && message.occupant) {
          appendCinemaAvatar(message.occupant);
        }
        break;

      case "cinema_occupant_leave":
        if (cinema.open && message.roomId === cinema.roomId) removeCinemaOccupant(message.cid);
        break;

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
    if (state.locationHidden) return;
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

  const ROOM_TYPE_META = {
    PUBLIC: { label: "Pública", className: "tag-public" },
    PRIVATE: { label: "Privada", className: "tag-private" },
    MY_ROOM: { label: "My Room", className: "tag-myroom" },
    AP: { label: "AP", className: "tag-ap" },
  };

  function normalizeRooms(message) {
    const list = Array.isArray(message.rooms) ? message.rooms : [];
    if (list.length) {
      return list.map((room) => ({
        ...room,
        occupants: Array.isArray(room.occupants) ? room.occupants : [],
      }));
    }
    if (message.room) {
      return [
        {
          ...message.room,
          occupants: Array.isArray(message.occupants) ? message.occupants : [],
        },
      ];
    }
    return [];
  }

  function roomTypeOf(room) {
    const type = String(room?.type || "").toUpperCase();
    if (ROOM_TYPE_META[type]) return type;
    const roomId = String(room?.roomId || "");
    if (roomId.endsWith("-1")) return "MY_ROOM";
    if (room?.privacy === "private" || room?.privacyLabel === "Privada") return "PRIVATE";
    return "PUBLIC";
  }

  function roomMetaOf(room) {
    return ROOM_TYPE_META[roomTypeOf(room)] || ROOM_TYPE_META.PUBLIC;
  }

  function roomDisplayName(room) {
    if (!room) return "—";
    const roomId = String(room.roomId || "").trim();
    const rawName = String(room.name || "").trim();
    const type = roomTypeOf(room);
    const isPrivate = type === "PRIVATE" || room.privacy === "private" || room.privacyLabel === "Privada";
    const genericName =
      !rawName ||
      rawName === roomId ||
      /^Sala \d+-\d+$/.test(rawName) ||
      /^Sala privada \(ID:/i.test(rawName);
    if (!genericName) return rawName;
    if (type === "MY_ROOM") return "My Room";
    if (isPrivate) return `Sala Privada (ID: ${roomId || "?"})`;
    return roomId ? `Sala Pública (ID: ${roomId})` : "—";
  }

  function renderRoomsGrid() {
    if (!els.roomsList) return;
    els.roomsList.replaceChildren();
    const rooms = state.rooms || [];
    const targetCid = state.target?.cid;

    for (const room of rooms) {
      const type = roomTypeOf(room);
      const meta = roomMetaOf(room);
      const roomId = String(room.roomId || "").trim();
      const isPrimary = state.room?.roomId === roomId;
      const directLink =
        String(room.directLink || "").trim() || (roomId ? `imvu://room/${roomId}` : "");
      const webLink =
        String(room.webLink || "").trim() ||
        (roomId ? `https://www.imvu.com/next/chat/room-${roomId}/` : "");

      const card = document.createElement("div");
      card.className = `room-card room-card-${type.toLowerCase()}${isPrimary ? " is-primary" : ""}`;
      card.dataset.roomId = roomId;

      const head = document.createElement("div");
      head.className = "room-card-head";
      const title = document.createElement("h3");
      title.className = "font-display room-card-name";
      title.textContent = roomDisplayName(room);
      head.append(title, makeBadge(meta.label, meta.className));

      const info = document.createElement("div");
      info.className = "mono room-card-meta";
      const bits = [];
      if (roomId) bits.push(`#${roomId}`);
      if (room.owner) bits.push(`dono ${room.owner}`);
      const people = Array.isArray(room.occupants) ? room.occupants : [];
      const occupancy = Math.max(Number(room.occupancy) || 0, people.length);
      const capacity = Number(room.capacity) > 0 ? ` / cap. ${room.capacity}` : "";
      bits.push(`${occupancy}${capacity} na sala`);
      info.textContent = bits.join(" · ");

      const actions = document.createElement("div");
      actions.className = "room-card-actions";
      const cinemaBtn = document.createElement("button");
      cinemaBtn.type = "button";
      cinemaBtn.className = "btn-ghost room-card-btn room-cinema-btn";
      cinemaBtn.dataset.roomId = roomId;
      cinemaBtn.textContent = "Assistir Sala";
      actions.appendChild(cinemaBtn);
      if (directLink) {
        const open = document.createElement("a");
        open.className = "btn-primary room-card-btn";
        open.href = directLink;
        open.textContent = "Abrir no IMVU";
        actions.appendChild(open);
      }
      if (webLink) {
        const web = document.createElement("a");
        web.className = "btn-ghost room-card-btn";
        web.href = webLink;
        web.target = "_blank";
        web.rel = "noopener";
        web.textContent = "Abrir na web";
        actions.appendChild(web);
      }
      const link = directLink || webLink;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn-ghost room-card-btn room-copy-btn";
      copy.dataset.link = link;
      copy.disabled = !link;
      copy.textContent = "Copiar link";
      actions.appendChild(copy);

      const direct = document.createElement("div");
      direct.className = "room-card-link mono";
      direct.textContent = link ? readableLink(link) : "—";

      const roster = document.createElement("div");
      roster.className = "room-roster";
      const sorted = [...people]
        .sort((a, b) => {
          if (a.cid === targetCid) return -1;
          if (b.cid === targetCid) return 1;
          return String(a.displayName || a.username || "").localeCompare(
            String(b.displayName || b.username || ""),
            "pt-BR"
          );
        })
        .slice(0, 8);
      for (const person of sorted) {
        const chip = document.createElement("span");
        chip.className = `room-roster-chip${person.cid === targetCid ? " is-target" : ""}`;
        chip.title = person.displayName || person.username || "";
        chip.appendChild(createAvatar(person, "room-roster-avatar"));
        const nick = document.createElement("span");
        nick.textContent = person.displayName || person.username || person.cid || "?";
        chip.appendChild(nick);
        roster.appendChild(chip);
      }
      if (!sorted.length) {
        const empty = document.createElement("span");
        empty.className = "room-roster-empty";
        empty.textContent = "ninguém visível";
        roster.appendChild(empty);
      } else if (people.length > sorted.length) {
        const more = document.createElement("span");
        more.className = "room-roster-more";
        more.textContent = `+${people.length - sorted.length}`;
        roster.appendChild(more);
      }

      card.append(head, info, actions, direct, roster);
      els.roomsList.appendChild(card);
    }
  }

  function renderRoom() {
    const rooms = state.rooms || [];
    const room = state.room || rooms[0] || null;

    if (!rooms.length) {
      if (state.locationHidden) {
        els.roomEmpty?.classList.add("hidden");
        els.roomContent?.classList.add("hidden");
        els.roomHidden?.classList.remove("hidden");
        if (els.roomHiddenText && state.locationHiddenText) {
          els.roomHiddenText.textContent = state.locationHiddenText;
        }
        if (els.roomBackdrop) {
          els.roomBackdrop.style.backgroundImage = "";
          els.roomBackdrop.style.opacity = "0";
        }
        els.roomCountBadge?.classList.add("hidden");
        return;
      }

      els.roomHidden?.classList.add("hidden");
      els.roomEmpty?.classList.remove("hidden");
      els.roomContent?.classList.add("hidden");
      if (els.roomBackdrop) {
        els.roomBackdrop.style.backgroundImage = "";
        els.roomBackdrop.style.opacity = "0";
      }
      els.roomCountBadge?.classList.add("hidden");
      if (els.roomsList) els.roomsList.replaceChildren();
      renderRoomsState();
      return;
    }

    els.roomHidden?.classList.add("hidden");
    els.roomEmpty?.classList.add("hidden");
    els.roomContent?.classList.remove("hidden");
    renderRoomsGrid();

    if (els.roomCountBadge) {
      els.roomCountBadge.textContent = String(rooms.length);
      els.roomCountBadge.classList.toggle("hidden", rooms.length < 2);
    }

    const backdrop = proxiedImage(room?.cover || room?.render || "");
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
      const targetName = state.target.displayName || state.target.username || "Nick";
      document.title =
        rooms.length > 1
          ? `${targetName} em ${rooms.length} salas — IMVU Radar`
          : `${targetName} em ${roomDisplayName(room)} — IMVU Radar`;
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
      card.title = "Clique para ver o perfil";
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

      card.addEventListener("click", () => openProfile(person));

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
      hidden: "room-status status-hidden",
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
    state.rooms = [];
    state.occupants = [];
    state.locationHidden = false;
    state.locationHiddenTitle = "";
    state.locationHiddenText = "";
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
    state.rooms = [];
    state.occupants = [];
    state.locationHidden = false;
    state.locationHiddenTitle = "";
    state.locationHiddenText = "";
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
    resetToIdle();
    toast("Monitoramento parado", {
      kind: "info",
      detail: alerts.enabled
        ? "Os alertas continuam ativos no painel."
        : "O radar não está mais vigiando esse nick.",
    });
  });

  els.roomsList?.addEventListener("click", (event) => {
    const cinemaBtn = event.target.closest(".room-cinema-btn");
    if (cinemaBtn) {
      const room = state.rooms.find((item) => item.roomId === cinemaBtn.dataset.roomId);
      if (room) openCinema(room);
      return;
    }
    const button = event.target.closest(".room-copy-btn");
    if (!button) return;
    copyText(button.dataset.link || "", "Link copiado");
  });

  els.alertsBtn?.addEventListener("click", alertsOpen);
  els.closeAlertsBtn?.addEventListener("click", alertsClose);
  els.alertsOverlay?.addEventListener("click", alertsClose);
  els.profileCloseBtn?.addEventListener("click", closeProfileModal);
  els.profileOverlay?.addEventListener("click", closeProfileModal);
  els.profileCopyBtn?.addEventListener("click", () => {
    copyText(els.profileCopyBtn.dataset.link || "", "Link do perfil copiado");
  });
  els.cinemaCloseBtn?.addEventListener("click", closeCinema);
  els.cinemaOverlay?.addEventListener("click", closeCinema);
  els.cinemaRoomImage?.addEventListener("error", () => {
    if (!cinema.open) return;
    els.cinemaRoomImage.style.display = "none";
    els.cinemaEmpty?.classList.remove("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (cinema.open) {
      closeCinema();
      return;
    }
    if (profileModal.open) {
      closeProfileModal();
      return;
    }
    alertsClose();
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

