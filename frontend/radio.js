(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const params = new URLSearchParams(window.location.search);
  const configuredBackend = String(params.get("backend") || window.RADAR_BACKEND || "").trim();
  const isHttpPage = window.location.protocol === "http:" || window.location.protocol === "https:";
  const HTTP_BASE = (
    configuredBackend || (isHttpPage ? window.location.origin : "http://localhost:8080")
  ).replace(/\/+$/, "");

  const els = {
    radarView: $("#radarView"),
    radioView: $("#radioView"),
    tabRadar: $("#tabRadar"),
    tabRadio: $("#tabRadio"),
    form: $("#radioForm"),
    roomInput: $("#radioRoomInput"),
    joinBtn: $("#radioJoinBtn"),
    status: $("#radioStatus"),
    statusText: $("#radioStatusText"),
    empty: $("#radioEmpty"),
    emptyTitle: $("#radioEmptyTitle"),
    emptyText: $("#radioEmptyText"),
    content: $("#radioContent"),
    roomName: $("#radioRoomName"),
    roomId: $("#radioRoomId"),
    now: $("#radioNow"),
    link: $("#radioLink"),
    disconnectBtn: $("#radioDisconnectBtn"),
    error: $("#radioError"),
    antiBan: $("#radioAntiBan"),
    toasts: $("#toasts"),
  };

  let pollTimer = null;
  let joining = false;
  let lastStatus = null;

  const timeOf = (value) => {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  function radioToast(title, detail = "", kind = "info") {
    if (!els.toasts) return;
    while (els.toasts.children.length >= 4) els.toasts.firstElementChild?.remove();

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
    close.addEventListener("click", () => element.remove());
    element.append(icon, body, close);
    els.toasts.appendChild(element);
    setTimeout(() => element.remove(), 5_000);
  }

  function setStatus(kind, text) {
    const map = {
      idle: "room-status status-idle",
      loading: "room-status status-loading",
      online: "room-status status-online",
      offline: "room-status status-offline",
      error: "room-status status-error",
    };
    els.status.className = map[kind] || map.idle;
    els.statusText.textContent = text;
  }

  function showError(message) {
    if (!els.error) return;
    if (!message) {
      els.error.classList.add("hidden");
      els.error.textContent = "";
      return;
    }
    els.error.textContent = message;
    els.error.classList.remove("hidden");
  }

  function setEmpty(title, text, icon = "headphones") {
    els.empty.classList.remove("hidden");
    els.content.classList.add("hidden");
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = text;
    const iconBox = els.empty.querySelector(".room-icon");
    if (iconBox) iconBox.dataset.kind = icon;
  }

  function renderStatus(status) {
    if (!status) return;
    lastStatus = status;

    if (Number(status.sendIntervalMs) >= 1500) {
      els.antiBan.textContent = `${(Number(status.sendIntervalMs) / 1000).toFixed(1).replace(".0", "")}s`;
    }

    if (status.configured === false) {
      setStatus("error", "Bot não configurado");
      setEmpty(
        "Bot não configurado",
        "Preencha BOT_USERNAME (ou BOT_EMAIL) e BOT_PASSWORD no backend/.env e reinicie o servidor."
      );
      showError("Configure as credenciais do bot no backend. O rastreador não é afetado.");
      if (els.joinBtn) els.joinBtn.disabled = false;
      return;
    }

    if (status.joining) {
      setStatus("loading", "Conectando...");
      setEmpty("Entrando na sala...", "O bot está logando e abrindo o chat via IMQ.");
      showError("");
      return;
    }

    if (status.connected) {
      setStatus("online", "Na sala");
      els.empty.classList.add("hidden");
      els.content.classList.remove("hidden");
      els.disconnectBtn?.classList.remove("hidden");
      els.roomName.textContent = status.roomName || "Sala";
      els.roomId.textContent = status.roomId || "—";
      els.now.textContent = status.radio || "—";
      const link = String(status.radioUrl || "");
      if (els.link) {
        els.link.href = link || "#";
        els.link.textContent = link || "—";
        els.link.classList.toggle("hidden", !link);
      }
      showError(status.lastError || status.warning || "");
      return;
    }

    if (status.loggedIn) {
      setStatus("offline", "Fora de sala");
      els.empty.classList.add("hidden");
      els.content.classList.remove("hidden");
      els.disconnectBtn?.classList.remove("hidden");
      els.roomName.textContent = "Fora de sala";
      els.roomId.textContent = "—";
      els.now.textContent = status.radio || "—";
      const link = String(status.radioUrl || "");
      if (els.link) {
        els.link.href = link || "#";
        els.link.textContent = link || "—";
        els.link.classList.toggle("hidden", !link);
      }
      showError(status.lastError || status.warning || "");
      return;
    }

    setStatus("idle", "Desconectado");
    setEmpty(
      "Bot fora da sala",
      "Informe o ID da sua sala para ativar o DJ.",
      "headphones"
    );
    showError(status.warning || status.lastError || "");
  }

  async function fetchStatus({ silent = false } = {}) {
    try {
      const response = await fetch(`${HTTP_BASE}/api/bot/status`, { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.status) {
        throw new Error(json?.error || `HTTP ${response.status}`);
      }
      renderStatus(json.status);
      if (!silent && !lastStatus?.configured) {
        /* status inicial sem toast */
      }
      return json.status;
    } catch (error) {
      if (!silent) {
        setStatus("error", "Backend offline");
        showError(`Não foi possível falar com o backend: ${error?.message || error}`);
      }
      return null;
    }
  }

  async function joinBot(event) {
    event?.preventDefault?.();
    if (joining) return;

    const raw = String(els.roomInput?.value || "").trim();
    const match = raw.match(/(\d+-\d+)/);
    const roomId = match ? match[1] : raw;
    if (!/^\d+-\d+$/.test(roomId)) {
      showError("ID inválido. Use o formato 123456-1.");
      radioToast("ID de sala inválido", "Use o formato 123456-1.", "warn");
      els.roomInput?.focus();
      return;
    }

    joining = true;
    els.joinBtn.disabled = true;
    els.joinBtn.textContent = "Conectando...";
    showError("");
    setStatus("loading", "Conectando...");
    setEmpty("Entrando na sala...", "O bot está logando e abrindo o chat via IMQ.");
    try {
      localStorage.setItem("radar:radioRoom", roomId);
    } catch {
      /* modo privado */
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(`${HTTP_BASE}/api/bot/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        if (json?.status) renderStatus(json.status);
        throw new Error(json?.error || `Falha ao entrar (HTTP ${response.status})`);
      }
      renderStatus(json.status);
      radioToast("DJ Bot ativado", `Entrou na sala ${json.status?.roomName || roomId}.`, "success");
      fetchStatus({ silent: true });
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "O bot demorou demais para conectar. Tente novamente."
          : error?.message || String(error);
      setStatus("error", "Falha no bot");
      showError(message);
      radioToast("Falha ao ativar o bot", message, "danger");
      await fetchStatus({ silent: true });
    } finally {
      clearTimeout(timeout);
      joining = false;
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = "Ativar DJ Bot";
    }
  }

  async function leaveBot() {
    if (joining) return;
    joining = true;
    els.joinBtn.disabled = true;
    els.disconnectBtn.disabled = true;
    setStatus("loading", "Desconectando...");
    try {
      const response = await fetch(`${HTTP_BASE}/api/bot/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) throw new Error(json?.error || "Falha ao desconectar.");
      renderStatus(json.status);
      radioToast("DJ Bot desconectado", "O bot saiu da sala.", "info");
    } catch (error) {
      const message = error?.message || String(error);
      setStatus("error", "Falha ao desconectar");
      showError(message);
      radioToast("Falha ao desconectar", message, "danger");
      await fetchStatus({ silent: true });
    } finally {
      joining = false;
      els.joinBtn.disabled = false;
      els.disconnectBtn.disabled = false;
    }
  }

  function setView(view) {
    const isRadio = view === "radio";
    els.radarView?.classList.toggle("hidden", isRadio);
    els.radioView?.classList.toggle("hidden", !isRadio);
    els.tabRadar?.classList.toggle("is-active", !isRadio);
    els.tabRadio?.classList.toggle("is-active", isRadio);
    document.body.dataset.view = isRadio ? "radio" : "radar";
    if (isRadio) {
      document.title = "Rádio para Sala — IMVU Radar";
      fetchStatus({ silent: true });
    } else {
      document.title = "IMVU Radar — presença em tempo real";
    }
  }

  els.tabRadar?.addEventListener("click", () => setView("radar"));
  els.tabRadio?.addEventListener("click", () => setView("radio"));
  els.form?.addEventListener("submit", joinBot);
  els.disconnectBtn?.addEventListener("click", leaveBot);

  try {
    const saved = localStorage.getItem("radar:radioRoom");
    if (saved && els.roomInput && !els.roomInput.value) els.roomInput.value = saved;
  } catch {
    /* modo privado */
  }

  if (String(params.get("view") || "").toLowerCase() === "radio") {
    setView("radio");
  } else {
    setView("radar");
  }

  fetchStatus({ silent: true });
  pollTimer = setInterval(() => {
    if (document.body.dataset.view === "radio") fetchStatus({ silent: true });
  }, 5_000);

  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
