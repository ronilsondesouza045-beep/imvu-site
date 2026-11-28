import { ImvuApi, safeNick } from "./imvu.js";
import { ImqClient, isLeftAction, isLiveAction, parseRoomId } from "./imq.js";
import {
  findRooms as catvuFind,
  fetchRoomSnapshot as catvuRoomSnapshot,
  watchRoom as catvuWatch,
  catvuPerson,
} from "./catvu.js";
import { sendPush, pushAvailable } from "./push.js";
import { SITE_URL } from "./site.js";

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const LIST_DEADLINE_MS = envInt("LIST_SCAN_DEADLINE_MS", 15_000);
const OWN_ROOM_SCAN = envInt("OWN_ROOM_SCAN", 120);
const OWN_DEADLINE_MS = envInt("OWN_SCAN_DEADLINE_MS", 12_000);
const CATVU_RETRY_MS = envInt("CATVU_RETRY_MS", 20_000);
const TARGET_ROOM_SCAN = envInt("TARGET_ROOM_SCAN", 800);
const PROBE_INTERVAL_MS = envInt("PROBE_INTERVAL_MS", 120_000);
const PROBE_TIMEOUT_MS = envInt("PROBE_TIMEOUT_MS", 12_000);
// Com salas ativas, refaz a sondagem das filas chat-<cid>-* para descobrir
// salas adicionais (multi-room). IMQ e a fonte primaria; isso e so fallback.
const MULTI_PROBE_MS = envInt("MULTI_PROBE_MS", 120_000);
// Janela de graca do IMQ no inicio do watch: se nenhum evento de sala chegar
// nesse tempo, o fallback (friends/relation/lists/scan) e acionado.
const IMQ_GRACE_MS = envInt("IMQ_GRACE_MS", 10_000);
// Estado "oculto" nao pode ser permanente: a privacidade do alvo pode mudar
// (Show Current Room) ou a sala pode ficar visivel depois. Recheca a cada 60s.
const HIDDEN_RETRY_MS = envInt("HIDDEN_RETRY_MS", 60_000);
// Varredura ativa de salas publicas (recent/explore/feature) para achar o
// alvo sem depender do current_room. Fallback: no maximo a cada 2 minutos.
const PUBLIC_SCAN_MS = envInt("PUBLIC_SCAN_MS", 120_000);
// Diretorio de chat profundo: a sala do alvo pode estar na pagina 24+.
const PUBLIC_SCAN_LIMIT = envInt("PUBLIC_SCAN_LIMIT", 1000);
const PUBLIC_SCAN_DEADLINE_MS = envInt("PUBLIC_SCAN_DEADLINE_MS", 120_000);
const PUBLIC_SCAN_CONCURRENCY = envInt("PUBLIC_SCAN_CONCURRENCY", 8);
// Varredura periodica em lotes rotativos (cobre o diretorio em ~3 ciclos).
const PUBLIC_SCAN_BATCH = envInt("PUBLIC_SCAN_BATCH", 400);
// No maximo N alvos com varredura profunda ao mesmo tempo.
const PUBLIC_SCAN_TRACKS = envInt("PUBLIC_SCAN_TRACKS", 2);
// Fallback de seguranca: o IMQ entrega as mudancas em tempo real. A relation
// current_room so e relida a cada 2 minutos para corrigir dessincronizacao.
const ROOM_REFRESH_MS = envInt("ROOM_REFRESH_MS", 120_000);
// Roster HTTP e metadados continuam mais espacados para nao estourar rate limit.
const ROSTER_REFRESH_MS = envInt("ROSTER_REFRESH_MS", 15_000);
// Lista de salas dos amigos: fonte real quando current_room nao existe.
const FRIENDS_HINT_MS = envInt("FRIENDS_HINT_MS", 5_000);
// Janela em que um evento de sala do IMQ vence uma relation "presa" na My Room.
const PRESENCE_TRUST_MS = envInt("PRESENCE_TRUST_MS", 10 * 60_000);
// Evita reabrir a sala que o alvo acabou de sair via evento left.
const LEFT_ROOM_GRACE_MS = envInt("LEFT_ROOM_GRACE_MS", 15_000);
const RATE_LIMIT_BACKOFF_MS = envInt("RATE_LIMIT_BACKOFF_MS", 30_000);
const ALERT_TTL_MS = envInt("ALERT_TTL_MS", 2 * 60 * 60 * 1000);
const MAX_ALERTS = envInt("MAX_ALERTS", 30);
const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isGenericRoomName(name, roomId) {
  const value = String(name || "").trim();
  if (!value) return true;
  if (value === String(roomId || "")) return true;
  if (/^Sala (privada|p[uú]blica) \(ID:/i.test(value)) return true;
  if (/^Sala \d+-\d+$/.test(value)) return true;
  return false;
}

export const ROOM_TYPE = Object.freeze({
  PUBLIC: "PUBLIC",
  PRIVATE: "PRIVATE",
  MY_ROOM: "MY_ROOM",
  AP: "AP",
});

export const ROOM_TYPE_LABEL = Object.freeze({
  PUBLIC: "Pública",
  PRIVATE: "Privada",
  MY_ROOM: "My Room",
  AP: "AP",
});

/**
 * Classifica o tipo da sala antes de enviar para o frontend.
 * Ordem (spec): My Room -> AP -> privacy.
 *
 * 1. room_id terminando em "-1"  => MY_ROOM
 * 2. room_id igual ao cid do alvo => AP (Avatar Page)
 * 3. privacy_type public          => PUBLIC
 * 4. qualquer outra coisa         => PRIVATE
 *
 * `meta` permite reconhecer APs que a API marca explicitamente como
 * room_type "ap"/"avatar_page".
 */
export function classifyRoomType(cid, roomId, privacy, meta = null) {
  const rid = String(roomId || "");
  const targetCid = String(cid || "");
  const normalizedPrivacy = String(privacy || "").toLowerCase();

  if (rid.endsWith("-1")) return ROOM_TYPE.MY_ROOM;
  if (targetCid && rid === targetCid) return ROOM_TYPE.AP;

  const hintType = String(meta?.room_type || meta?.roomType || meta?.type || "").toLowerCase();
  if (hintType === "ap" || hintType === "avatar_page" || hintType === "avatar-page") {
    return ROOM_TYPE.AP;
  }

  return normalizedPrivacy === "public" ? ROOM_TYPE.PUBLIC : ROOM_TYPE.PRIVATE;
}

/** Nome exibivel: nome real, ou null para o frontend montar o fallback. */
function displayRoomName(name, roomId, { ownMyRoom = false } = {}) {
  const value = String(name || "").trim();
  if (value && !isGenericRoomName(value, roomId)) return value;
  if (ownMyRoom) return "My Room";
  return null;
}

function occupantFromPerson(person) {
  return {
    cid: person.cid,
    username: person.username,
    displayName: person.displayName,
    nick: person.username,
    avatar: person.portrait || person.avatar || person.render || "",
    avatarPortrait: person.portrait || "",
    avatarImage: person.avatar || "",
    render: person.render || "",
    isVip: Boolean(person.isVip),
    isAp: Boolean(person.isAp),
    online: Boolean(person.online),
  };
}

export class RadarTracker {
  constructor({ username, password, log = console } = {}) {
    this.log = log;
    this.api = new ImvuApi({ username, password, log });
    this.tracks = new Map();
    this.roomRefs = new Map();
    this.alerts = new Map();
    this.imqStarted = false;
    // Limita varreduras profundas simultaneas (cada uma usa ~8 requests).
    this.publicScanActive = 0;
    this.publicScanWaiters = [];
    // Hook externo (Telegram, etc.): chamado quando um track troca de sala.
    this.onRoomChange = null;

    this.imq = new ImqClient({
      log,
      targetScan: TARGET_ROOM_SCAN,
      getAuth: async () => {
        const ok = await this.api.ensureLogin();
        if (!ok) throw new Error(this.api.lastError || "login falhou");
        return {
          cid: this.api.cid,
          sessionId: this.api.sessionId,
          username: this.api.username,
        };
      },
      onAuthError: () => {
        // Forca um novo login no proximo reconnect.
        this.api.loggedIn = false;
        this.api.sauce = "";
      },
      onEvent: (event) => this.onImqEvent(event),
    });
  }

  async ensureLogin() {
    const ok = await this.api.ensureLogin();
    if (!ok) return false;
    if (!this.imqStarted) {
      this.imqStarted = true;
      this.imq.start();
    }
    return true;
  }

  isActive(track, gen = track.gen) {
    return this.tracks.get(track.cid) === track && track.gen === gen;
  }



  // ---------------- ciclo de vida do watcher ----------------

  async watch(client, rawNick) {
    const nick = safeNick(rawNick);
    if (!nick) {
      client.send({ type: "error", code: "invalid_nick", message: "Digite um nick valido." });
      return;
    }

    this.unwatch(client, { silent: true });
    const gen = (client.watchGen || 0) + 1;
    client.watchGen = gen;
    client.send({ type: "status", state: "loading", message: "Conectando ao IMVU..." });

    const logged = await this.ensureLogin();
    if (client.watchGen !== gen) return;
    if (!logged) {
      client.send({
        type: "error",
        code: "login_failed",
        message: this.api.lastError || "Falha ao autenticar no IMVU.",
      });
      return;
    }

    let profile;
    try {
      profile = await this.api.resolve(nick);
    } catch (error) {
      profile = null;
      this.log.warn(`[tracker] resolve(${nick}) falhou: ${error?.message || error}`);
    }
    if (client.watchGen !== gen) return;
    if (!profile) {
      client.send({
        type: "error",
        code: "nick_not_found",
        message: `Nick "${nick}" nao encontrado no IMVU.`,
      });
      return;
    }

    let track = this.tracks.get(profile.cid);
    if (!track) {
      track = this.createTrack(profile);
      this.tracks.set(profile.cid, track);
      client.track = track;
      client.watchGen = gen;
      track.watchers.add(client);
      client.send(this.watchingMessage(track));
      this.emitStatus(track, "loading", "Procurando sala atual...");
      this.log.info(`[IMQ] ${profile.username} (${profile.cid}): assinando chat-${profile.cid}-* + presence`);
      this.imq.addTarget(profile.cid);
      this.startTimers(track);
      this.startSync(track);
    } else {
      client.track = track;
      client.watchGen = gen;
      track.watchers.add(client);
      this.sendCurrent(client, track);
    }
  }

  createTrack(profile) {
    return {
      cid: profile.cid,
      profile,
      nick: profile.username,
      watchers: new Set(),
      alerts: new Map(),
      // Multi-room: cada sala ativa tem seu proprio card/roster.
      // `room`/`occupants` continuam apontando para a sala primaria
      // (a mais recente) por compatibilidade com alertas e push.
      rooms: new Map(),
      room: null,
      occupants: new Map(),
      state: "loading",
      statusMsg: "Procurando sala atual...",
      detectedBy: "",
      locationHidden: false,
      locationHiddenAt: 0,
      gen: 0,
      lastLive: new Set(),
      liveStreaks: new Map(),
      myRoomStreak: 0,
      ownRoomPromise: null,
      backgroundDiscoveryPromise: null,
      probeInFlight: null,
      pendingRoomLoads: new Map(),
      refreshTimers: new Map(),
      lastProbeAt: 0,
      probeTimer: null,
      refreshLoopTimer: null,
      syncPromise: null,
      syncBackoffUntil: 0,
      presenceRoom: "",
      presenceRoomAt: 0,
      lastImqRoomAt: 0,
      imqWaitPromise: null,
      imqWaitTimer: null,
      lastLeftRoom: "",
      lastLeftAt: 0,
      lastRosterRefreshAt: 0,
      friendsHintAt: 0,
      lastPublicScanAt: 0,
      publicScanCursor: 0,
      publicScanPromise: null,
      roomSetSeq: 0,
      catvu: null,
      catvuWatch: null,
      catvuRoomId: "",
      catvuHadSnapshot: false,
      catvuSnapshotAt: 0,
      catvuSnapshotLoading: false,
      pendingJoins: new Set(),
      catvuLastTry: 0,
      createdAt: now(),
    };
  }

  startTimers(track) {
    if (!track.probeTimer) {
      track.probeTimer = setInterval(() => {
        if (this.tracks.get(track.cid) !== track) return;
        // Sem sala a sondagem roda rapido (15s). Com salas, varre as filas
        // chat-<cid>-* de tempo em tempos para descobrir salas adicionais.
        if (track.rooms.size && now() - (track.lastProbeAt || 0) < MULTI_PROBE_MS) return;
        track.lastProbeAt = now();
        this.probeTick(track).catch((error) => {
          this.log.warn(`[tracker] probe(${track.cid}) falhou: ${error?.message || error}`);
        });
      }, PROBE_INTERVAL_MS);
    }
    if (!track.refreshLoopTimer) {
      track.refreshLoopTimer = setInterval(() => {
        if (this.tracks.get(track.cid) !== track) return;
        if (track.locationHidden) {
          if (now() - (track.locationHiddenAt || 0) < HIDDEN_RETRY_MS) return;
          // Janela de rechecagem: libera as fontes por um tick. Se nada
          // aparecer, rearma o estado hidden sem floodar o frontend.
          track.locationHidden = false;
          track.locationHiddenAt = now();
          this.syncCurrentRoom(track)
            .then((found) => {
              if (!found && !track.rooms.size && this.tracks.get(track.cid) === track) {
                track.locationHidden = true;
                track.locationHiddenAt = now();
              }
            })
            .catch(() => {
              if (!track.rooms.size && this.tracks.get(track.cid) === track) {
                track.locationHidden = true;
                track.locationHiddenAt = now();
              }
            });
          return;
        }
        // current_room: barato e a cada tick (deteccao de troca de sala).
        this.syncCurrentRoom(track).catch(() => {});
        if (!track.rooms.size) return;
        // Roster/metadados: menos frequente para respeitar o rate limit.
        // Em multi-room atualiza UMA sala por tick (a mais antiga) para nao
        // estourar o rate limit do IMVU; o IMQ mantem os rosters em tempo real.
        if (now() - (track.lastRosterRefreshAt || 0) < ROSTER_REFRESH_MS) return;
        track.lastRosterRefreshAt = now();
        let oldest = null;
        for (const [rid, entry] of track.rooms) {
          if (!oldest || (entry.lastRefreshedAt || 0) < (oldest.entry.lastRefreshedAt || 0)) {
            oldest = { rid, entry };
          }
        }
        if (oldest) {
          this.refreshRoomById(track, oldest.rid, { notify: false }).catch(() => {});
        }
      }, ROOM_REFRESH_MS);
    }
  }

  clearTrackTimers(track) {
    if (track.probeTimer) clearInterval(track.probeTimer);
    if (track.refreshLoopTimer) clearInterval(track.refreshLoopTimer);
    for (const pending of track.pendingRoomLoads?.values() || []) {
      if (pending?.timer) clearTimeout(pending.timer);
    }
    for (const refresh of track.refreshTimers?.values() || []) {
      if (refresh?.timer) clearTimeout(refresh.timer);
    }
    track.pendingRoomLoads?.clear();
    track.refreshTimers?.clear();
    track.probeTimer = null;
    track.refreshLoopTimer = null;
  }

  unwatch(client, { silent = false } = {}) {
    const track = client.track;
    client.track = null;
    client.watchGen = (client.watchGen || 0) + 1;
    if (!track) {
      if (!silent) client.send({ type: "stopped" });
      return;
    }
    track.watchers.delete(client);
    if (track.watchers.size === 0 && track.alerts.size === 0) {
      this.destroyTrack(track);
    }
    if (!silent) client.send({ type: "stopped" });
  }

  destroyTrack(track) {
    this.clearTrackTimers(track);
    this.stopCatvuWatch(track);
    for (const alert of [...track.alerts.values()]) {
      if (alert.timer) clearTimeout(alert.timer);
      this.alerts.delete(alert.endpoint);
    }
    track.alerts.clear();
    if (track.rooms?.size) {
      for (const rid of [...track.rooms.keys()]) this.releaseRoom(rid);
      track.rooms.clear();
    } else if (track.room) {
      this.releaseRoom(track.room.roomId);
    }
    this.imq.removeTarget(track.cid);
    this.tracks.delete(track.cid);
    this.log.info(`[tracker] parou de vigiar ${track.nick} (${track.cid})`);
  }

  stopCatvuWatch(track) {
    if (track.catvuWatch) {
      try {
        track.catvuWatch.stop();
      } catch {
        /* ignora */
      }
    }
    track.catvuWatch = null;
    track.catvuRoomId = "";
    track.catvuHadSnapshot = false;
  }

  destroy() {
    for (const track of [...this.tracks.values()]) this.destroyTrack(track);
    for (const alert of this.alerts.values()) {
      if (alert.timer) clearTimeout(alert.timer);
    }
    this.alerts.clear();
    this.imq.stop();
  }

  // ---------------- mensagens ----------------

  watchingMessage(track) {
    return {
      type: "watching",
      target: track.profile,
      nick: track.nick,
      cid: track.cid,
      at: now(),
    };
  }

  statusMessage(track, state = track.state, message = track.statusMsg) {
    return {
      type: "status",
      state,
      message,
      target: track.profile,
      nick: track.nick,
      at: now(),
    };
  }

  occupantList(track) {
    return [...track.occupants.values()];
  }

  /** Payload de UMA sala ativa (card do frontend). */
  roomPayload(entry) {
    if (!entry?.room) return null;
    const total = entry.occupants?.size || 0;
    return {
      ...entry.room,
      type: entry.type,
      typeLabel: ROOM_TYPE_LABEL[entry.type] || "",
      detectedBy: entry.detectedBy || "",
      lastSeenAt: entry.lastSeenAt || 0,
      occupancy: Math.max(Number(entry.room.occupancy) || 0, total),
      occupants: [...(entry.occupants?.values() || [])],
      total,
    };
  }

  /** Lista de salas ativas, mais recente primeiro. */
  roomList(track) {
    return [...track.rooms.values()]
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .map((entry) => this.roomPayload(entry))
      .filter(Boolean);
  }

  /**
   * Define a sala primaria (a mais recente). Mantem `track.room` e
   * `track.occupants` para os consumidores antigos (push, Telegram).
   */
  selectPrimary(track) {
    let best = null;
    for (const entry of track.rooms.values()) {
      if (!best || (entry.lastSeenAt || 0) > (best.lastSeenAt || 0)) best = entry;
    }
    if (!best) {
      track.room = null;
      track.occupants = new Map();
      return null;
    }
    track.room = best.room;
    track.occupants = best.occupants;
    return best;
  }

  syncPrimaryOccupants(track, rid) {
    const entry = track.rooms.get(String(rid || ""));
    if (entry && track.room?.roomId === entry.room.roomId) {
      track.occupants = entry.occupants;
    }
  }

  roomMessage(track) {
    const rooms = this.roomList(track);
    const primaryId = String(track.room?.roomId || "");
    const room = rooms.find((item) => item.roomId === primaryId) || rooms[0] || null;
    return {
      type: "room",
      target: track.profile,
      nick: track.nick,
      // `rooms` e a lista multi-sala; `room`/`occupants` continuam sendo a
      // sala primaria para clientes antigos.
      room,
      rooms,
      occupants: room?.occupants || this.occupantList(track),
      total: room?.total ?? track.occupants.size,
      detectedBy: track.detectedBy,
      at: now(),
    };
  }

  locationHiddenMessage(track) {
    return {
      type: "location_hidden",
      target: track.profile,
      nick: track.nick,
      title: "Localização Indisponível",
      message:
        "Este usuário pode ter desativado a opção 'Show Current Room' no perfil do IMVU. Para permitir o rastreamento, ele precisa ativar essa opção nas configurações de privacidade.",
      helpUrl: "#ajuda",
      at: now(),
    };
  }

  sendCurrent(client, track) {
    client.send(this.watchingMessage(track));
    if (track.locationHidden) {
      client.send(this.locationHiddenMessage(track));
    } else if (track.room) {
      client.send(this.roomMessage(track));
    }
    client.send(this.statusMessage(track));
  }

  emitStatus(track, state, message) {
    track.state = state;
    track.statusMsg = message;
    this.broadcast(track, this.statusMessage(track, state, message));
  }

  broadcast(track, message) {
    for (const client of track.watchers) {
      client.send(message);
    }
  }

  /**
   * O IMVU nao expoe a sala de terceiros quando o alvo desliga o
   * "Show Current Room". Nao adianta continuar batendo em friends/catvu:
   * marca como indisponivel, avisa o frontend e para o polling de sala.
   * O IMQ continua assinado e pode reverter isso se um evento trouxer sala.
   */
  markLocationHidden(track, reason = "sala nao exposta pelo IMVU") {
    if (track.locationHidden) return;
    track.locationHidden = true;
    track.locationHiddenAt = now();
    track.detectedBy = "hidden";
    track.state = "hidden";
    track.statusMsg = "Indisponível";
    this.log.warn(
      `[tracker] ${track.nick} (${track.cid}): ${reason}; parando buscas por friends/catvu`
    );
    this.broadcast(track, this.locationHiddenMessage(track));
    this.broadcast(track, this.statusMessage(track, "hidden", track.statusMsg));
  }

  // ---------------- sync inicial ----------------

  startSync(track) {
    const gen = track.gen + 1;
    track.gen = gen;
    this.emitStatus(track, "loading", "Procurando sala atual...");
    this.initialSync(track, gen).catch((error) => {
      if (!this.isActive(track, gen)) return;
      this.log.warn(`[tracker] sync(${track.nick}) falhou: ${error?.message || error}`);
      this.emitStatus(track, "offline", "Nao foi possivel ler a sala agora. Monitorando...");
    });
  }

  async initialSync(track, gen) {
    const active = () => this.isActive(track, gen);

    // 0) FAST-PATH: o IMQ ja foi assinado no watch (chat-<cid>-* +
    // presence-<cid>). Damos uma janela curta para ele entregar a sala.
    track.imqWatchStartedAt = now();
    this.emitStatus(track, "loading", "Ouvindo IMQ em tempo real...");
    this.log.info(
      `[IMQ] ${track.nick} (${track.cid}): aguardando evento de sala (${IMQ_GRACE_MS / 1000}s)`
    );

    if (await this.waitForImqRoom(track, IMQ_GRACE_MS)) {
      if (!active()) return;
      const elapsed = now() - (track.imqWatchStartedAt || track.createdAt || now());
      this.log.info(
        `[IMQ] ${track.nick}: sala ${track.room?.roomId || ""} detectada em ${elapsed}ms; varredura publica cancelada`
      );
      this.scheduleBackgroundDiscovery(track, gen);
      return;
    }
    if (!active()) return;

    // 1) FALLBACK: IMQ silencioso por 10s. Fontes baratas primeiro.
    this.log.info(
      `[IMQ] ${track.nick}: nenhum evento em ${IMQ_GRACE_MS / 1000}s; ativando fallback`
    );
    this.emitStatus(track, "loading", "IMQ sem eventos; consultando salas dos amigos...");
    if (await this.checkFriendsRoom(track)) {
      this.scheduleBackgroundDiscovery(track, gen);
      return;
    }
    if (!active()) return;

    // 2) Sondagem IMQ: relation current_room + catvu + filas chat-<cid>-*.
    this.emitStatus(track, "loading", "Sondando canais em tempo real...");
    await this.probeTick(track);
    if (!active()) return;
    if (track.rooms.size) {
      this.scheduleBackgroundDiscovery(track, gen);
      return;
    }

    // 3) Listas oficiais: friends / recent / explore.
    this.emitStatus(track, "loading", "Varrendo listas oficiais...");
    const listHits = await this.api.findInLists(track.cid, ["friends", "recent", "explore"], {
      deadlineMs: now() + LIST_DEADLINE_MS,
      stopOnFirst: true,
      concurrency: 5,
      onRoom: () => {},
    });
    if (!active()) return;
    if (listHits.length) {
      await this.setRoom(track, listHits[0].rid, {
        seed: listHits[0].people,
        via: "listas",
        gen,
      });
      this.scheduleBackgroundDiscovery(track, gen);
      return;
    }

    // 4) Salas proprias do alvo com ocupacao > 0.
    this.emitStatus(track, "loading", "Varrendo salas do alvo...");
    const ownHits = await this.api.findInOwnRooms(track.cid, OWN_ROOM_SCAN, {
      deadlineMs: now() + OWN_DEADLINE_MS,
      concurrency: 6,
    });
    if (!active()) return;
    if (ownHits.length) {
      await this.setRoom(track, ownHits[0].rid, {
        seed: ownHits[0].people,
        via: "own_rooms",
        gen,
      });
      this.scheduleBackgroundDiscovery(track, gen);
      return;
    }

    // 5) Ultimo recurso: varredura publica em background, no maximo 1x/2min.
    // Nao bloqueia o watch; se achar a sala, o card entra na hora.
    if (track.profile?.online !== false) {
      this.emitStatus(track, "loading", "IMQ sem eventos; varrendo salas públicas em segundo plano...");
      this.scanPublicRooms(track)
        .then((found) => {
          if (!this.isActive(track, gen) || found || track.rooms.size) return;
          this.markLocationHidden(track, "current_room ausente e nenhuma sala encontrada");
        })
        .catch(() => {
          if (!this.isActive(track, gen) || track.rooms.size) return;
          this.markLocationHidden(track, "falha na varredura de salas públicas");
        });
      return;
    }

    this.emitStatus(track, "offline", "Sem sala no momento. Monitorando em tempo real...");
    this.broadcast(track, {
      type: "offline",
      target: track.profile,
      nick: track.nick,
      message: "Sem sala no momento",
      at: now(),
    });
  }

  /**
   * Espera ate `timeoutMs` por uma sala vinda do IMQ (track.rooms preenchido).
   * Resolve true assim que o fast-path publica a primeira sala.
   */
  waitForImqRoom(track, timeoutMs) {
    if (track.rooms.size) return Promise.resolve(true);
    if (track.imqWaitPromise) return track.imqWaitPromise;
    const started = now();
    track.imqWaitPromise = new Promise((resolve) => {
      track.imqWaitTimer = setInterval(() => {
        if (this.tracks.get(track.cid) !== track) {
          clearInterval(track.imqWaitTimer);
          track.imqWaitTimer = null;
          resolve(false);
          return;
        }
        if (track.rooms.size) {
          clearInterval(track.imqWaitTimer);
          track.imqWaitTimer = null;
          resolve(true);
          return;
        }
        if (now() - started >= timeoutMs) {
          clearInterval(track.imqWaitTimer);
          track.imqWaitTimer = null;
          resolve(false);
        }
      }, 150);
    }).finally(() => {
      track.imqWaitPromise = null;
    });
    return track.imqWaitPromise;
  }

  /**
   * Usa o resultado do catvu para cravar a sala. Se o roster do IMVU
   * confirmar o cid, melhor; se nao, confia no find (ele devolve a sala
   * atual mesmo para alvo parado/sala privada).
   */
  async applyCatvuResult(track, result, gen) {
    if (!result?.rooms?.length) return false;
    if (!this.isActive(track, gen) || track.room) return false;
    track.catvu = result;

    const rooms = [...result.rooms];
    const rank = (room) => {
      let score = 0;
      if (room.isPrivate && result.hasOccupiedPrivateRoom) score += 100;
      if (room.source === "find_locations") score += 60;
      if (room.source === "imq_enum") score += 50;
      if (room.isPrivate) score += 30;
      return score;
    };
    rooms.sort((a, b) => rank(b) - rank(a));

    for (const candidate of rooms.slice(0, 4)) {
      if (!this.isActive(track, gen) || track.room) break;
      const people = await this.api.roster(candidate.roomId, 0).catch(() => []);
      if (!this.isActive(track, gen) || track.room) return Boolean(track.room);

      if (people.some((person) => person.cid === track.cid)) {
        await this.setRoom(track, candidate.roomId, {
          seed: people,
          via: candidate.isPrivate ? "catvu_private" : "catvu",
          hint: candidate,
          gen,
        });
        return true;
      }

      const trusted =
        rooms.length === 1 ||
        candidate.source === "find_locations" ||
        (candidate.isPrivate && result.hasOccupiedPrivateRoom);
      if (trusted) {
        await this.setRoom(track, candidate.roomId, {
          seed: people,
          via: candidate.isPrivate ? "catvu_private" : "catvu",
          hint: candidate,
          gen,
        });
        return true;
      }
    }
    return false;
  }

  // ---------------- probe ----------------

  /**
   * A lista `friends` do IMVU devolve as salas dos amigos. Para sala privada
   * de terceiro o roster HTTP vem 403, entao confiamos na lista quando o
   * bot tem um unico amigo — e esse amigo e o alvo (fallback do Tracker.kt).
   */
  async checkFriendsRoom(track) {
    if (track.locationHidden) return false;
    if (now() - (track.friendsHintAt || 0) < FRIENDS_HINT_MS) return false;
    track.friendsHintAt = now();

    const hints = await this.api.friendsRoomHints().catch(() => []);
    if (!hints.length || this.tracks.get(track.cid) !== track) return false;

    // 1) Sala publica: roster confirma o alvo.
    for (const hint of hints) {
      const people = await this.api.roster(hint.rid, 2_000).catch(() => []);
      if (this.tracks.get(track.cid) !== track) return false;
      if (people.some((person) => person.cid === track.cid)) {
        if (track.room?.roomId !== hint.rid) {
          this.setRoom(track, hint.rid, {
            seed: people,
            via: "friends",
            hint,
            gen: track.gen,
          }).catch((error) => {
            this.log.warn(`[tracker] friends setRoom(${hint.rid}) falhou: ${error?.message || error}`);
          });
        }
        return true;
      }
    }

    // 2) Sala privada: roster 403. Unico amigo + unica sala = sala do alvo.
    if (hints.length === 1) {
      const friends = await this.api.friendCids().catch(() => new Set());
      if (this.tracks.get(track.cid) !== track) return false;
      if (friends.size === 1 && friends.has(String(track.cid))) {
        const hint = hints[0];
        if (track.room?.roomId !== hint.rid) {
          this.setRoom(track, hint.rid, {
            via: "friends_private",
            hint,
            gen: track.gen,
          }).catch((error) => {
            this.log.warn(`[tracker] friends_private setRoom(${hint.rid}) falhou: ${error?.message || error}`);
          });
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Descobre salas PROPRIAS do alvo (My Room / privadas) pelas filas de chat
   * dele no IMQ: chat-<cid>-N viva em dois probes seguidos. O REST dessas
   * salas costuma ser 403, entao a fila e a unica prova disponivel.
   */
  async discoverOwnRooms(track, gen = track.gen) {
    if (this.tracks.get(track.cid) !== track) return false;
    if (track.ownRoomPromise) return track.ownRoomPromise;
    track.ownRoomPromise = (async () => {
      const first = await this.imq.probeQueues(track.cid, PROBE_TIMEOUT_MS);
      if (!this.isActive(track, gen)) return false;
      const own = first.filter(
        (rid) => rid.startsWith(`${track.cid}-`) && !track.rooms.has(rid)
      );
      if (!own.length) return false;

      // Confirma que a fila continua viva alguns segundos depois; evita
      // adicionar uma sala antiga que so apareceu uma vez.
      await sleep(5_000);
      if (!this.isActive(track, gen)) return false;
      const second = await this.imq.probeQueues(track.cid, PROBE_TIMEOUT_MS);
      if (!this.isActive(track, gen)) return false;

      const persistent = own.filter((rid) => second.includes(rid) && !track.rooms.has(rid));
      let added = 0;
      for (const rid of persistent) {
        const people = await this.api.roster(rid, 1_500).catch(() => []);
        if (!this.isActive(track, gen)) return added > 0;
        const seed = people.some((person) => person.cid === track.cid) ? people : null;
        await this.setRoom(track, rid, {
          seed,
          via: "imq_own_room",
          hint: { isPrivate: rid !== `${track.cid}-1`, privacy: "private" },
          gen: track.gen,
        });
        added += 1;
      }
      return added > 0;
    })()
      .catch(() => false)
      .finally(() => {
        track.ownRoomPromise = null;
      });
    return track.ownRoomPromise;
  }

  /**
   * Depois do primeiro card, continua a busca em background para cobrir o
   * resto: salas proprias (My Room/privadas) e varredura publica profunda
   * (se ela ainda nao rodou).
   */
  scheduleBackgroundDiscovery(track, gen) {
    if (this.tracks.get(track.cid) !== track) return null;
    if (track.backgroundDiscoveryPromise) return track.backgroundDiscoveryPromise;
    track.backgroundDiscoveryPromise = (async () => {
      await sleep(400);
      if (!this.isActive(track, gen)) return;
      const tasks = [this.discoverOwnRooms(track, gen)];
      // Se o IMQ (ou qualquer fonte) ja achou sala, a varredura publica fica
      // cancelada. Ela so roda quando ainda nao ha nenhuma sala — fallback real.
      if (!track.rooms.size) tasks.push(this.scanPublicRooms(track));
      await Promise.allSettled(tasks);
    })()
      .catch(() => {})
      .finally(() => {
        track.backgroundDiscoveryPromise = null;
      });
    return track.backgroundDiscoveryPromise;
  }

  async acquirePublicScanSlot() {
    if (this.publicScanActive < PUBLIC_SCAN_TRACKS) {
      this.publicScanActive += 1;
      return;
    }
    await new Promise((resolve) => this.publicScanWaiters.push(resolve));
    this.publicScanActive += 1;
  }

  releasePublicScanSlot() {
    this.publicScanActive = Math.max(0, this.publicScanActive - 1);
    const next = this.publicScanWaiters.shift();
    if (next) next();
  }

  /**
   * Varredura ativa do diretorio de salas publicas de chat (paginado de 25
   * em 25, ate PUBLIC_SCAN_LIMIT) + listas personalizadas. Confirma pelo
   * roster e adiciona cada sala onde o alvo esta.
   *
   * force=true (watch inicial): varre o diretorio inteiro e retorna assim
   * que a primeira sala e achada (o resto continua em background).
   * force=false (loop): varre um lote rotativo a cada PUBLIC_SCAN_MS para
   * cobrir o diretorio sem estourar rate limit.
   */
  async scanPublicRooms(track, { force = false } = {}) {
    if (this.tracks.get(track.cid) !== track) return false;
    if (track.locationHidden) return false;
    // Fast-path ja achou sala: nao gasta recurso varrendo o diretorio.
    if (track.rooms.size) {
      this.log.info(`[IMQ] varredura ignorada: sala de ${track.nick} ja detectada`);
      return true;
    }
    if (track.publicScanPromise) return track.publicScanPromise;
    if (!force && now() - (track.lastPublicScanAt || 0) < PUBLIC_SCAN_MS) return false;
    track.lastPublicScanAt = now();

    let earlyResolve = null;
    const early = new Promise((resolve) => {
      earlyResolve = resolve;
    });

    const full = (async () => {
      await this.acquirePublicScanSlot();
      let progressTimer = null;
      try {
        const candidates = await this.api
          .publicRoomCandidates({ limit: PUBLIC_SCAN_LIMIT })
          .catch(() => []);
        if (this.tracks.get(track.cid) !== track) return false;
        if (track.rooms.size) {
          this.log.info(`[IMQ] varredura cancelada: sala de ${track.nick} ja detectada`);
          return true;
        }
        if (!candidates.length) return false;

        let window = candidates;
        if (!force) {
          const batchSize = Math.min(PUBLIC_SCAN_BATCH, candidates.length);
          const start = (track.publicScanCursor || 0) % candidates.length;
          window = [];
          for (let i = 0; i < batchSize; i += 1) {
            window.push(candidates[(start + i) % candidates.length]);
          }
          track.publicScanCursor = (start + batchSize) % candidates.length;
        } else {
          track.publicScanCursor = 0;
        }

        const deadline = now() + PUBLIC_SCAN_DEADLINE_MS;
        const showProgress = force || track.rooms.size === 0;
        let found = false;
        let cancelled = false;
        let scanned = 0;
        let index = 0;
        let lastProgressAt = now();

        if (showProgress) {
          this.emitStatus(track, "loading", `Varrendo ${window.length} salas públicas...`);
        }

        progressTimer = setInterval(() => {
          if (!showProgress || found || this.tracks.get(track.cid) !== track) return;
          if (now() - lastProgressAt < 7_500) return;
          lastProgressAt = now();
          this.emitStatus(track, "loading", `Varrendo salas públicas (${scanned}/${window.length})...`);
        }, 2_500);

        await Promise.all(
          Array.from({ length: Math.min(PUBLIC_SCAN_CONCURRENCY, window.length) }, async () => {
            while (true) {
              if (this.tracks.get(track.cid) !== track) return;
              if (track.rooms.size) {
                if (!cancelled) {
                  cancelled = true;
                  this.log.info(`[IMQ] varredura cancelada: sala de ${track.nick} ja detectada`);
                }
                return;
              }
              if (now() > deadline) return;
              const i = index++;
              if (i >= window.length) return;
              const candidate = window[i];
              const rid = String(candidate?.rid || "");
              if (!/^\d+-\d+$/.test(rid)) {
                scanned += 1;
                continue;
              }
              let people = await this.api.roster(rid, 2_000).catch(() => []);
              if (this.api.lastStatus === 429) {
                await sleep(2_500);
                people = await this.api.roster(rid, 0).catch(() => []);
              }
              scanned += 1;
              if (this.tracks.get(track.cid) !== track) return;
              if (!people.some((person) => person.cid === track.cid)) continue;
              if (!found) {
                found = true;
                earlyResolve?.(true);
              }
              await this.setRoom(track, rid, {
                seed: people,
                via: "public_scan",
                hint: {
                  roomId: rid,
                  name: candidate.name || "",
                  privacy: candidate.privacy || "public",
                  isPrivate: false,
                  occupancy: candidate.occupancy,
                  capacity: candidate.capacity,
                  render: candidate.render || "",
                  cover: candidate.image || "",
                },
                gen: track.gen,
              });
            }
          })
        );
        if (found) {
          this.log.info(
            `[tracker] ${track.nick}: encontrado em sala publica via varredura (${scanned}/${window.length})`
          );
        }
        return found;
      } finally {
        if (progressTimer) clearInterval(progressTimer);
        this.releasePublicScanSlot();
      }
    })()
      .catch((error) => {
        this.log.warn(`[tracker] varredura publica de ${track.nick} falhou: ${error?.message || error}`);
        return false;
      })
      .finally(() => {
        if (track.publicScanPromise === full) track.publicScanPromise = null;
      });

    track.publicScanPromise = full;
    const winner = await Promise.race([full, early]);
    return Boolean(winner);
  }

  async syncCurrentRoom(track) {
    if (this.tracks.get(track.cid) !== track) return false;
    // Localizacao oculta: nao insiste em current_room/friends/catvu.
    if (track.locationHidden) return false;
    if (track.syncPromise) return track.syncPromise;

    track.syncPromise = (async () => {
      if (track.syncBackoffUntil && now() < track.syncBackoffUntil) return false;

      // 1) current_room: uma request barata. O IMQ entrega o tempo real;
      // isso so corrige uma eventual dessincronizacao (no maximo 1x/2min).
      const rid = await this.api.currentRoom(track.cid, 0).catch(() => "");
      if (this.tracks.get(track.cid) !== track) return false;

      if (!rid) {
        if (this.api.lastStatus === 429) {
          track.syncBackoffUntil = now() + RATE_LIMIT_BACKOFF_MS;
          this.log.warn(`[tracker] rate limit no current_room de ${track.nick}; pausando ${Math.round(RATE_LIMIT_BACKOFF_MS / 1000)}s`);
          return false;
        }
        track.syncBackoffUntil = 0;
      } else {
        track.syncBackoffUntil = 0;
        const existing = track.rooms.get(rid);
        if (existing) {
          // current_room aponta para uma sala ja ativa: so reafirma o frescor.
          existing.lastSeenAt = now();
          this.selectPrimary(track);
          return true;
        }

        // My Room na relation costuma ficar "presa" enquanto o alvo esta em
        // sala de terceiro. A presenca fresca do IMQ vence essa leitura.
        const relationMyRoom = rid === `${track.cid}-1`;
        if (relationMyRoom) {
          const presenceFresh = Boolean(
            track.presenceRoom &&
              track.presenceRoom !== rid &&
              now() - (track.presenceRoomAt || 0) < PRESENCE_TRUST_MS
          );
          if (presenceFresh) return false;
        }

        // Nao reabre a sala que o alvo acabou de sair (evento left do IMQ).
        if (rid === track.lastLeftRoom && now() - (track.lastLeftAt || 0) < LEFT_ROOM_GRACE_MS) {
          return false;
        }

        // Relation em sala normal confirma a leitura: descarta presenca antiga
        // para ela nao bloquear uma futura volta do alvo para a My Room.
        if (!relationMyRoom) {
          track.presenceRoom = "";
          track.presenceRoomAt = 0;
        }

        // setRoom publica a sala de forma sincrona (antes do primeiro await).
        this.setRoom(track, rid, { via: "user_relation", gen: track.gen }).catch((error) => {
          this.log.warn(`[tracker] setRoom(${rid}) falhou: ${error?.message || error}`);
        });
        return true;
      }

      // 2) Lista de amigos do bot: fonte oficial denormalizada.
      if (await this.checkFriendsRoom(track)) return true;
      if (this.tracks.get(track.cid) !== track) return false;

      // 3) Varredura publica: so sem nenhuma sala e respeitando o throttle
      // de PUBLIC_SCAN_MS (2 minutos).
      if (!track.rooms.size && (await this.scanPublicRooms(track))) return true;
      return false;
    })()
      .catch(() => false)
      .finally(() => {
        track.syncPromise = null;
      });

    return track.syncPromise;
  }

  async probeTick(track) {
    if (this.tracks.get(track.cid) !== track) return;
    if (track.probeInFlight) return track.probeInFlight;
    track.probeInFlight = (async () => {
      // Primeiro tenta a relation current_room do IMVU (uma request barata).
      if (!track.rooms.size && !track.locationHidden) {
        const relationRoom = await this.api.currentRoom(track.cid, 0).catch(() => "");
        if (this.tracks.get(track.cid) !== track) return;
        if (relationRoom) {
          await this.setRoom(track, relationRoom, { via: "user_relation", gen: track.gen });
          return;
        }
      }

      // Rechecagem periodica do catvu: se o alvo entrou/esta parado numa sala
      // que o evento do IMQ nao cobriu, o find devolve o roomId exato.
      if (!track.rooms.size && !track.locationHidden && now() - (track.catvuLastTry || 0) > CATVU_RETRY_MS) {
        track.catvuLastTry = now();
        const result = await catvuFind(track.nick, { timeout: 8_000 }).catch(() => null);
        if (this.tracks.get(track.cid) !== track) return;
        if (result && (await this.applyCatvuResult(track, result, track.gen))) return;
      }

      // Varre as filas chat-<cid>-* mesmo com salas ativas: e assim que
      // salas adicionais (multi-room) entram na lista.
      const live = await this.imq.probeQueues(track.cid, PROBE_TIMEOUT_MS);
      if (this.tracks.get(track.cid) !== track) return;
      await this.evaluateLive(track, live);
    })()
      .catch((error) => {
        this.log.warn(`[tracker] probe(${track.nick}) erro: ${error?.message || error}`);
      })
      .finally(() => {
        track.probeInFlight = null;
      });
    return track.probeInFlight;
  }

  async evaluateLive(track, live) {
    const own = [...new Set(live)].filter((rid) => rid.startsWith(track.cid + "-"));
    if (!own.length) {
      track.lastLive = new Set();
      track.myRoomStreak = 0;
      return;
    }

    const missing = own.filter((rid) => !track.rooms.has(rid));

    // 1) Confirma pelo roster TODAS as salas vivas onde o alvo aparece.
    //    Sem filtro de privacy: sala publica entra igual a privada.
    let added = 0;
    for (const rid of missing.slice(0, 8)) {
      if (this.tracks.get(track.cid) !== track) return;
      const people = await this.api.roster(rid, 0).catch(() => []);
      if (this.tracks.get(track.cid) !== track) return;
      if (people.some((person) => person.cid === track.cid)) {
        await this.setRoom(track, rid, { seed: people, via: "probe_roster", gen: track.gen });
        added += 1;
      }
    }
    if (added) {
      track.lastLive = new Set(own);
      return;
    }

    // 2) Sala nova unica que apareceu entre dois probes (sem roster legivel).
    if (track.lastLive.size > 0) {
      const fresh = missing.filter((rid) => !track.lastLive.has(rid));
      if (fresh.length === 1 && !track.rooms.size) {
        await this.setRoom(track, fresh[0], { via: "imq_new", gen: track.gen });
        return;
      }
    }

    // 3) My Room (<cid>-1) viva em dois probes seguidos.
    if (own.includes(`${track.cid}-1`)) {
      track.myRoomStreak += 1;
      if (track.myRoomStreak >= 2 && !track.rooms.has(`${track.cid}-1`)) {
        await this.setRoom(track, `${track.cid}-1`, { via: "myroom", gen: track.gen });
        return;
      }
    } else {
      track.myRoomStreak = 0;
    }

    // 4) Uma unica sala viva e nenhuma rastreada ainda.
    if (own.length === 1 && !track.rooms.size) {
      await this.setRoom(track, own[0], { via: "imq_probe", gen: track.gen });
      return;
    }

    // 5) Salas PROPRIAS (<cid>-N) vivas em dois probes seguidos. O REST
    //    dessas salas costuma ser 403 (AUTHORIZATION-003), entao a fila de
    //    chat e a prova disponivel para My Room/custom/privadas.
    if (!track.liveStreaks) track.liveStreaks = new Map();
    const ownSet = new Set(own);
    for (const rid of own) {
      track.liveStreaks.set(rid, (track.liveStreaks.get(rid) || 0) + 1);
    }
    for (const rid of [...track.liveStreaks.keys()]) {
      if (!ownSet.has(rid)) track.liveStreaks.delete(rid);
    }
    const persistentOwn = [...track.liveStreaks.entries()]
      .filter(([rid, count]) => count >= 2 && !track.rooms.has(rid))
      .map(([rid]) => rid);
    for (const rid of persistentOwn) {
      const people = await this.api.roster(rid, 1_500).catch(() => []);
      if (this.tracks.get(track.cid) !== track) return;
      const seed = people.some((person) => person.cid === track.cid) ? people : null;
      await this.setRoom(track, rid, {
        seed,
        via: "imq_own_room",
        hint: { isPrivate: rid !== `${track.cid}-1`, privacy: "private" },
        gen: track.gen,
      });
    }

    track.lastLive = new Set(own);
  }

  // ---------------- sala e ocupantes ----------------

  acquireRoom(rid) {
    const count = this.roomRefs.get(rid) || 0;
    this.roomRefs.set(rid, count + 1);
    if (count === 0) {
      this.imq.addRoom(rid);
      this.log.info(`[IMQ] assinando chat-${rid} + presence-${rid}`);
    }
  }

  releaseRoom(rid) {
    const count = this.roomRefs.get(rid) || 0;
    if (count <= 1) {
      this.roomRefs.delete(rid);
      this.imq.removeRoom(rid);
    } else {
      this.roomRefs.set(rid, count - 1);
    }
  }

  buildOccupants(track, people) {
    const map = new Map();
    for (const person of people || []) {
      if (!person?.cid) continue;
      map.set(person.cid, occupantFromPerson(person));
    }
    if (!map.has(track.cid)) {
      map.set(track.cid, occupantFromPerson(track.profile));
    }
    return map;
  }

  async setRoom(track, rid, { seed = null, via = "imq", hint = null, gen = track.gen } = {}) {
    if (!this.isActive(track, gen)) return;
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return;

    if (track.locationHidden) {
      track.locationHidden = false;
      track.locationHiddenAt = 0;
      this.log.info(`[tracker] ${track.nick}: localizacao voltou a ser visivel (${via})`);
    }

    // Sala ja ativa: somente reafirma a presenca (nao recria o card).
    const existing = track.rooms.get(id);
    if (existing) {
      existing.lastSeenAt = now();
      existing.detectedBy = via;
      if (Array.isArray(seed) && seed.length) {
        const previous = existing.occupants;
        existing.occupants = this.buildOccupants(track, seed);
        this.syncPrimaryOccupants(track, id);
        if (existing.occupants.size !== previous.size) {
          this.broadcast(track, this.roomMessage(track));
        }
      }
      this.selectPrimary(track);
      return;
    }

    const hintName = String(hint?.name || hint?.roomName || "").trim();
    const hintPrivate = Boolean(
      hint?.isPrivate ?? hint?.is_private ?? String(hint?.privacy || "").toLowerCase() === "private"
    );
    const ownMyRoom = id === `${track.cid}-1`;
    const initialPrivacy = hintPrivate ? "private" : "public";
    const fallbackRoom = {
      roomId: id,
      name: displayRoomName(hintName, id, { ownMyRoom }),
      privacy: initialPrivacy,
      privacyLabel: hintPrivate ? "Privada" : "Pública",
      type: classifyRoomType(track.cid, id, initialPrivacy, hint),
      restricted: hintPrivate,
      owner: "",
      occupancy: Array.isArray(seed) ? seed.length : 0,
      capacity: 0,
      render: "",
      cover: "",
      description: "",
      joinUrl: `https://go.imvu.com/chat/room-${id}`,
      directLink: `imvu://room/${id}`,
      webLink: `https://www.imvu.com/next/chat/room-${id}/`,
      error: "",
      message: "",
      source: hint ? "catvu" : "imvu",
    };

    const previousRoom = track.room;
    const seq = (track.roomSetSeq || 0) + 1;
    track.roomSetSeq = seq;
    const entry = {
      room: fallbackRoom,
      occupants: this.buildOccupants(track, seed || []),
      type: fallbackRoom.type,
      detectedBy: via,
      lastSeenAt: now(),
      lastRefreshedAt: 0,
      missedCount: 0,
      catvuSnapshotAt: 0,
      catvuSnapshotLoading: false,
      seq,
    };

    this.acquireRoom(id);
    track.rooms.set(id, entry);
    this.selectPrimary(track);
    track.detectedBy = via;
    track.state = "online";
    track.statusMsg = `Na sala ${fallbackRoom.name || id}`;
    track.lastLive = new Set();
    track.myRoomStreak = 0;
    track.lastRosterRefreshAt = now();

    // O card entra no painel imediatamente (relation/IMQ). Metadados e roster
    // sao enriquecidos depois, sem bloquear a deteccao.
    this.broadcast(track, this.roomMessage(track));
    this.broadcast(track, this.statusMessage(track, "online", track.statusMsg));
    this.log.info(`[tracker] ${track.nick} -> ${fallbackRoom.name || id} (${id}) via ${via}`);

    // Hook externo (ex.: alertas do Telegram). Nao interfere no fluxo do radar.
    if (typeof this.onRoomChange === "function") {
      try {
        this.onRoomChange(track, previousRoom);
      } catch (error) {
        this.log.warn(`[tracker] onRoomChange falhou: ${error?.message || error}`);
      }
    }

    const [info, people] = await Promise.all([
      this.api.roomInfo(id, hint).catch(() => null),
      seed ? Promise.resolve(seed) : this.api.roster(id, 0).catch(() => []),
    ]);
    if (!this.isActive(track, gen)) return;
    const liveEntry = track.rooms.get(id);
    if (!liveEntry || liveEntry.seq !== seq) return;

    let privacy = initialPrivacy;
    let room = { ...fallbackRoom };
    if (info) {
      const isPrivate = info.privacy === "private" || Boolean(info.restricted);
      privacy = isPrivate ? "private" : "public";
      room = {
        ...fallbackRoom,
        ...info,
        roomId: id,
        name: displayRoomName(info.name, id, { ownMyRoom }),
        privacy,
        privacyLabel: isPrivate ? "Privada" : "Pública",
        restricted: Boolean(info.restricted),
        directLink: String(info.directLink || fallbackRoom.directLink || `imvu://room/${id}`),
        webLink: String(info.webLink || fallbackRoom.webLink || ""),
      };
    }

    // Nao deixa um nome generico ("Sala 123-4"/"Sala privada (ID: ...)")
    // sobrescrever um nome real ja resolvido pelo catvu.
    const infoName = String(room.name || "").trim();
    const liveName = String(liveEntry.room.name || "").trim();
    if (isGenericRoomName(infoName, id) && liveName && !isGenericRoomName(liveName, id)) {
      room.name = liveName;
    } else if (isGenericRoomName(infoName, id)) {
      room.name = displayRoomName(hintName, id, { ownMyRoom });
    }

    room.type = classifyRoomType(track.cid, id, privacy, info);
    liveEntry.room = room;
    liveEntry.type = room.type;
    liveEntry.occupants = this.buildOccupants(track, people);
    liveEntry.lastRefreshedAt = now();
    this.selectPrimary(track);
    track.statusMsg = `Na sala ${room.name || id}`;

    const needsCatvuWatch =
      privacy === "private" ||
      room.restricted ||
      people.length === 0 ||
      via.startsWith("catvu_private");
    if (needsCatvuWatch) {
      this.loadCatvuSnapshot(track, id).catch(() => {});
    }

    this.broadcast(track, this.roomMessage(track));
    this.broadcast(track, this.statusMessage(track, "online", track.statusMsg));

    if (track.alerts.size) {
      const roomLabel = room.name || (privacy === "private" ? `Sala Privada (ID: ${id})` : `Sala ${id}`);
      this.pushTrack(track, {
        title: previousRoom?.roomId && previousRoom.roomId !== id ? "Entrou em outra sala" : "Está na sala",
        body: `${track.profile.displayName || track.nick} • ${roomLabel}${privacy === "private" ? " (privada)" : ""}`,
        tag: `room-${id}`,
      });
    }
  }

  mergeOccupant(previous, incoming) {
    if (!previous) return incoming;
    return {
      ...previous,
      ...incoming,
      avatar: previous.avatar || incoming.avatar,
      avatarPortrait: previous.avatarPortrait || incoming.avatarPortrait,
      avatarImage: previous.avatarImage || incoming.avatarImage,
      render: previous.render || incoming.render,
      displayName: incoming.displayName || previous.displayName,
      username: incoming.username || previous.username,
      isVip: incoming.isVip || previous.isVip,
      isAp: incoming.isAp || previous.isAp,
    };
  }

  emitOccupantJoin(track, person, rid = "") {
    const id = String(rid || track.room?.roomId || track.catvuRoomId || "");
    const entry = track.rooms.get(id);
    const total = entry?.occupants.size ?? track.occupants.size;
    this.broadcast(track, {
      type: "occupant_join",
      target: track.profile,
      nick: track.nick,
      room: id,
      cid: person.cid,
      occupant: person,
      total,
      at: now(),
    });
    if (track.alerts.size) {
      const roomName = entry?.room?.name || track.room?.name || "sala";
      this.pushTrack(track, {
        title: "Entrou na sala",
        body: `${person.displayName || person.username} entrou em ${roomName}`,
        tag: `join-${person.cid}-${now()}`,
        occupants: true,
      });
    }
  }

  emitOccupantLeave(track, person, rid = "") {
    const id = String(rid || track.room?.roomId || track.catvuRoomId || "");
    const entry = track.rooms.get(id);
    const total = entry?.occupants.size ?? track.occupants.size;
    this.broadcast(track, {
      type: "occupant_leave",
      target: track.profile,
      nick: track.nick,
      room: id,
      cid: person.cid,
      nickOut: person.username,
      occupant: person,
      total,
      at: now(),
    });
    if (track.alerts.size) {
      const roomName = entry?.room?.name || track.room?.name || "sala";
      this.pushTrack(track, {
        title: "Saiu da sala",
        body: `${person.displayName || person.username} saiu de ${roomName}`,
        tag: `leave-${person.cid}-${now()}`,
        occupants: true,
      });
    }
  }

  /**
   * Roster SSE do catvu. Entra em cena quando o IMVU esconde o roster
   * (sala privada de terceiro) ou quando a sala foi descoberta pelo find
   * e ainda nao tem ocupantes legiveis.
   */
  startCatvuWatch(track, rid) {
    const id = String(rid || "");
    if (!id) return;
    if (track.catvuWatch && track.catvuRoomId === id) return;

    this.stopCatvuWatch(track);
    track.catvuRoomId = id;
    track.catvuHadSnapshot = false;

    track.catvuWatch = catvuWatch(id, {
      log: this.log,
      onSnapshot: (participants) => {
        if (this.tracks.get(track.cid) !== track) return;
        if (track.room?.roomId !== id) return;
        const people = (participants || []).map(catvuPerson).filter(Boolean);
        if (!people.length) return;
        this.applyCatvuPeople(track, people, { initial: !track.catvuHadSnapshot });
        track.catvuHadSnapshot = true;
      },
      onJoin: (raw) => {
        if (this.tracks.get(track.cid) !== track) return;
        if (track.room?.roomId !== id) return;
        const person = catvuPerson(raw?.person || raw);
        if (person?.cid) this.applyCatvuJoin(track, person);
      },
      onLeave: (raw) => {
        if (this.tracks.get(track.cid) !== track) return;
        if (track.room?.roomId !== id) return;
        const person = catvuPerson(raw?.person || raw || {});
        if (person?.cid) this.applyCatvuLeave(track, person);
      },
      onStatus: (data) => {
        if (typeof data?.message === "string") {
          this.log.info(`[catvu] ${id}: ${data.message}`);
        }
      },
      onError: () => {
        /* reconecta sozinho; nao polui o log */
      },
    });
    this.log.info(`[catvu] observando roster de ${id}`);
  }

  /**
   * Roster inicial de sala privada em UMA request (catvu /api/room?lite=1).
   * Depois disso o IMQ (chat-<roomId>) mantem joined/left em tempo real.
   */
  async loadCatvuSnapshot(track, rid) {
    const id = String(rid || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    if (entry.catvuSnapshotLoading) return;
    // No Render a busca vai pelo Jina e é mais lenta: espaça mais.
    const minInterval = process.env.RENDER === "true" ? 60_000 : 15_000;
    if (entry.catvuSnapshotAt && now() - entry.catvuSnapshotAt < minInterval) return;
    entry.catvuSnapshotLoading = true;
    try {
      const snapshot = await catvuRoomSnapshot(id, track.nick, { timeout: 30_000 });
      if (this.tracks.get(track.cid) !== track) return;
      const live = track.rooms.get(id);
      if (!live) return;

      if (snapshot?.room?.name) {
        const currentName = String(live.room.name || "");
        if (!currentName || currentName === id || currentName.startsWith("Sala ")) {
          live.room = { ...live.room, name: String(snapshot.room.name) };
        }
      }
      if (snapshot?.room?.isPrivate && live.room.privacy !== "private") {
        live.room = { ...live.room, privacy: "private", privacyLabel: "Privada" };
      }
      live.room.type = classifyRoomType(track.cid, id, live.room.privacy, live.room);
      live.type = live.room.type;
      if (track.room?.roomId === id) track.room = live.room;

      const people = (snapshot?.participants || [])
        .map((person) => ({
          cid: String(person?.cid || ""),
          username: String(person?.username || person?.cid || ""),
          displayName: String(person?.displayName || person?.username || person?.cid || ""),
          avatar: "",
          portrait: "",
          render: "",
          isVip: false,
          isAp: false,
          online: true,
        }))
        .filter((person) => /^\d+$/.test(person.cid));

      if (people.length) {
        this.applyCatvuPeople(track, people, { initial: true, rid: id });
        this.enrichOccupants(track, people.map((person) => person.cid), id).catch(() => {});
      }

      live.catvuSnapshotAt = now();
      if (snapshot?.room?.name) this.broadcast(track, this.roomMessage(track));
    } catch (error) {
      this.log.warn(`[catvu] snapshot ${id} falhou: ${error?.message || error}`);
      const live = track.rooms.get(id);
      if (live) live.catvuSnapshotAt = now();
    } finally {
      const live = track.rooms.get(id);
      if (live) live.catvuSnapshotLoading = false;
    }
  }

  /** Completa os ocupantes do catvu com o avatar 2D do IMVU (api.imvu.com). */
  async enrichOccupants(track, cids, rid = track.room?.roomId) {
    const id = String(rid || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    const unique = [...new Set((cids || []).filter((cid) => /^\d+$/.test(String(cid))))];
    let index = 0;
    const workers = Array.from({ length: Math.min(4, unique.length || 1) }, async () => {
      while (true) {
        const i = index++;
        if (i >= unique.length) return;
        const live = track.rooms.get(id);
        if (this.tracks.get(track.cid) !== track || !live) return;
        const cid = unique[i];
        const current = live.occupants.get(cid);
        if (!current || current.avatarPortrait) continue;
        const person = await this.api.resolveCid(cid).catch(() => null);
        if (!person) continue;
        const after = track.rooms.get(id);
        if (this.tracks.get(track.cid) !== track || !after) return;
        const existing = after.occupants.get(cid);
        if (!existing) continue;
        after.occupants.set(cid, this.mergeOccupant(existing, occupantFromPerson(person)));
      }
    });
    await Promise.all(workers);
    if (this.tracks.get(track.cid) === track) {
      this.broadcast(track, this.roomMessage(track));
    }
  }

  applyCatvuPeople(track, people, { initial = false, rid = "" } = {}) {
    const id = String(rid || track.catvuRoomId || track.room?.roomId || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    const old = entry.occupants;
    const next = new Map();
    next.set(track.cid, old.get(track.cid) || occupantFromPerson(track.profile));

    for (const person of people) {
      if (!person?.cid) continue;
      const incoming = occupantFromPerson(person);
      next.set(person.cid, this.mergeOccupant(old.get(person.cid), incoming));
    }

    entry.occupants = next;
    this.syncPrimaryOccupants(track, id);

    if (!initial) {
      for (const person of next.values()) {
        if (person.cid === track.cid) continue;
        if (!old.has(person.cid)) this.emitOccupantJoin(track, person, id);
      }
      for (const person of old.values()) {
        if (person.cid === track.cid) continue;
        if (!next.has(person.cid)) this.emitOccupantLeave(track, person, id);
      }
    }

    this.broadcast(track, this.roomMessage(track));
  }

  applyCatvuJoin(track, person, rid = "") {
    if (person.cid === track.cid) return;
    const id = String(rid || track.catvuRoomId || track.room?.roomId || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    const previous = entry.occupants.get(person.cid);
    const occupant = this.mergeOccupant(previous, occupantFromPerson(person));
    entry.occupants.set(person.cid, occupant);
    this.syncPrimaryOccupants(track, id);
    if (!previous) this.emitOccupantJoin(track, occupant, id);
    this.broadcast(track, this.roomMessage(track));
  }

  applyCatvuLeave(track, person, rid = "") {
    if (person.cid === track.cid) return;
    const id = String(rid || track.catvuRoomId || track.room?.roomId || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    const existing = entry.occupants.get(person.cid);
    if (!existing) return;
    entry.occupants.delete(person.cid);
    this.syncPrimaryOccupants(track, id);
    this.emitOccupantLeave(track, existing, id);
    this.broadcast(track, this.roomMessage(track));
  }

  /**
   * Evento edge:participants de quem entrou numa sala que estamos vigiando.
   * Resolve o cid no IMVU e adiciona na hora — funciona mesmo quando o
   * roster HTTP da sala privada vem 403.
   */
  async ensureOccupant(track, cid, rid = "") {
    const id = String(cid || "");
    const roomId = String(rid || track.room?.roomId || "");
    if (!/^\d+$/.test(id) || !/^\d+-\d+$/.test(roomId)) return;
    if (this.tracks.get(track.cid) !== track) return;
    const entry = track.rooms.get(roomId);
    if (!entry) return;
    if (id === track.cid) return;
    const pendingKey = `${roomId}:${id}`;
    if (entry.occupants.has(id) || track.pendingJoins.has(pendingKey)) return;

    track.pendingJoins.add(pendingKey);
    try {
      const person = await this.api.resolveCid(id).catch(() => null);
      if (this.tracks.get(track.cid) !== track) return;
      const live = track.rooms.get(roomId);
      if (!live) return;
      if (live.occupants.has(id)) return;
      const occupant = person
        ? occupantFromPerson(person)
        : {
            cid: id,
            username: id,
            displayName: id,
            nick: id,
            avatar: "",
            avatarPortrait: "",
            avatarImage: "",
            render: "",
            isVip: false,
            isAp: false,
            online: true,
          };
      live.occupants.set(id, occupant);
      this.syncPrimaryOccupants(track, roomId);
      this.emitOccupantJoin(track, occupant, roomId);
      this.broadcast(track, this.roomMessage(track));
    } finally {
      track.pendingJoins.delete(pendingKey);
    }
  }

  clearRoom(track, reason = "left") {
    const rid = track.room?.roomId;
    if (!rid) return;
    this.removeRoom(track, rid, reason);
  }

  /** Remove UMA sala da lista ativa (evento deleted/left do IMQ). */
  removeRoom(track, rid, reason = "left") {
    const id = String(rid || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    if (track.catvuRoomId === id) this.stopCatvuWatch(track);

    track.rooms.delete(id);
    this.releaseRoom(id);

    if (track.presenceRoom === id) {
      track.presenceRoom = "";
      track.presenceRoomAt = 0;
    }
    track.lastLeftRoom = id;
    track.lastLeftAt = now();
    track.locationHidden = false;
    track.locationHiddenAt = 0;

    const refresh = track.refreshTimers.get(id);
    if (refresh) {
      clearTimeout(refresh.timer);
      track.refreshTimers.delete(id);
    }

    const wasPrimary = track.room?.roomId === id;
    this.selectPrimary(track);
    if (wasPrimary && track.room) {
      track.detectedBy = track.rooms.get(track.room.roomId)?.detectedBy || "";
      track.state = "online";
      track.statusMsg = `Na sala ${track.room.name || track.room.roomId}`;
    } else if (!track.rooms.size) {
      track.detectedBy = "";
      track.state = "offline";
      track.statusMsg = "Fora de sala. Monitorando em tempo real...";
    }

    const oldRoom = entry.room;
    this.broadcast(track, {
      type: "room_leave",
      target: track.profile,
      nick: track.nick,
      room: oldRoom,
      rooms: this.roomList(track),
      reason,
      message: "Saiu da sala",
      at: now(),
    });
    this.broadcast(track, this.roomMessage(track));
    this.broadcast(track, this.statusMessage(track, track.state, track.statusMsg));
    if (track.alerts.size) {
      const roomLabel =
        oldRoom.name || (oldRoom.privacy === "private" ? `Sala Privada (ID: ${id})` : `Sala ${id}`);
      this.pushTrack(track, {
        title: "Saiu da sala",
        body: `${track.profile.displayName || track.nick} saiu de ${roomLabel}`,
        tag: `left-${id}`,
      });
    }

    // Pode ter trocado de sala direto; uma sondagem curta resolve.
    if (!track.rooms.size) {
      setTimeout(() => {
        if (this.tracks.get(track.cid) === track && !track.rooms.size) {
          this.probeTick(track).catch(() => {});
        }
      }, 2_500);
    }
  }

  async refreshRoom(track, options = {}) {
    const rid = track.room?.roomId;
    if (!rid) return;
    await this.refreshRoomById(track, rid, options);
  }

  async refreshRoomById(track, rid, { notify = false } = {}) {
    const id = String(rid || "");
    const entry = track.rooms.get(id);
    if (!entry) return;
    const [info, people] = await Promise.all([
      this.api.roomInfo(id, entry.room).catch(() => null),
      this.api.roster(id, 0).catch(() => []),
    ]);
    if (this.tracks.get(track.cid) !== track) return;
    const live = track.rooms.get(id);
    if (!live || live !== entry) return;
    live.lastRefreshedAt = now();

    if (info) {
      const isPrivate = info.privacy === "private" || Boolean(info.restricted);
      const ownMyRoom = id === `${track.cid}-1`;
      const infoName = displayRoomName(info.name, id, { ownMyRoom });
      const liveName = displayRoomName(live.room.name, id, { ownMyRoom });
      live.room = {
        ...live.room,
        ...info,
        name: liveName || infoName,
        privacy: isPrivate ? "private" : "public",
        privacyLabel: isPrivate ? "Privada" : "Pública",
        restricted: Boolean(info.restricted),
        occupancy: Math.max(Number(info.occupancy) || 0, people.length),
      };
      live.room.type = classifyRoomType(track.cid, id, live.room.privacy, info);
      live.type = live.room.type;
      if (track.room?.roomId === id) {
        track.room = live.room;
        track.statusMsg = `Na sala ${live.room.name || id}`;
      }
    }

    const needsPrivateFill = live.room.privacy === "private" || live.room.restricted;
    if (needsPrivateFill && (!live.catvuSnapshotAt || now() - live.catvuSnapshotAt > 60_000)) {
      this.loadCatvuSnapshot(track, id).catch(() => {});
    }

    // Sala publica onde o alvo nao aparece mais em rostes consecutivos:
    // sem evento deleted do IMQ, remove depois de 2 leituras para nao
    // manter assinatura de presenca de sala que ele ja deixou.
    const isPublicRoom = live.room.privacy !== "private" && !live.room.restricted;
    const targetInRoster = people.some((person) => person.cid === track.cid);
    if (isPublicRoom && people.length && !targetInRoster) {
      live.missedCount = (live.missedCount || 0) + 1;
      if (live.missedCount >= 2) {
        this.removeRoom(track, id, "not_in_room");
        return;
      }
    } else if (targetInRoster) {
      live.missedCount = 0;
    }

    // Roster vazio pode ser falha transitória (403/timeout) em sala privada.
    // Nesse caso preserva o snapshot anterior em vez de sumir com todo mundo.
    if (!people.length && live.occupants.size > 1) {
      if (notify) this.broadcast(track, this.roomMessage(track));
      return;
    }

    const old = live.occupants;
    const next = this.buildOccupants(track, people);
    const joins = [...next.values()].filter((person) => person.cid !== track.cid && !old.has(person.cid));
    const leaves = [...old.values()].filter((person) => person.cid !== track.cid && !next.has(person.cid));
    live.occupants = next;
    this.syncPrimaryOccupants(track, id);

    if (notify) {
      for (const person of joins) {
        this.broadcast(track, {
          type: "occupant_join",
          target: track.profile,
          nick: track.nick,
          room: id,
          cid: person.cid,
          occupant: person,
          total: next.size,
          at: now(),
        });
      }
      for (const person of leaves) {
        this.broadcast(track, {
          type: "occupant_leave",
          target: track.profile,
          nick: track.nick,
          room: id,
          cid: person.cid,
          nickOut: person.username,
          occupant: person,
          total: next.size,
          at: now(),
        });
      }
    }

    if (notify || joins.length || leaves.length) {
      this.broadcast(track, this.roomMessage(track));
    }
  }

  // ---------------- eventos do IMQ ----------------

  onImqEvent(event) {
    switch (event.type) {
      case "presence":
        this.onPresence(event);
        break;
      case "state":
        this.onState(event);
        break;
      case "imq_ready":
        this.log.info("[IMQ] conectado e pronto para eventos");
        break;
      case "imq_error":
        this.log.warn(`[IMQ] erro: ${event.message}`);
        break;
      default:
        break;
    }
  }

  onPresence(event) {
    const room = String(event.room || "");
    const cid = String(event.cid || "");
    const action = String(event.action || "");
    if (!room || !cid) return;

    for (const track of this.tracks.values()) {
      if (track.cid === cid) {
        if (isLiveAction(action)) {
          // O IMQ viu o alvo nesta sala: esta informacao vence a relation
          // quando ela estiver presa na My Room. Cada sala vira um card.
          track.presenceRoom = room;
          track.presenceRoomAt = now();
          track.lastImqRoomAt = now();
          const existing = track.rooms.get(room);
          if (existing) {
            existing.lastSeenAt = now();
          } else {
            const elapsed = now() - (track.imqWatchStartedAt || track.createdAt || now());
            this.log.info(
              `[IMQ] ${track.nick} (${track.cid}): sala ${room} via ${event.source || "imq"} em ${elapsed}ms`
            );
            this.scheduleRoomLoad(track, room, "imq", { immediate: true });
          }
        } else if (isLeftAction(action)) {
          this.log.info(
            `[IMQ] ${track.nick} (${track.cid}): saiu da sala ${room} (${event.source || "imq"})`
          );
          if (track.presenceRoom === room) {
            track.presenceRoom = "";
            track.presenceRoomAt = 0;
          }
          // deleted chat-<cid>-<room_id>: remove SOMENTE essa sala.
          this.removeRoom(track, room, "left");
        }
        continue;
      }

      const entry = track.rooms.get(room);
      if (!entry) continue;

      if (isLiveAction(action)) {
        this.ensureOccupant(track, cid, room).catch(() => {});
        this.scheduleRefresh(track, room, true);
      } else if (isLeftAction(action)) {
        const person = entry.occupants.get(cid);
        if (person) {
          entry.occupants.delete(cid);
          this.syncPrimaryOccupants(track, room);
          this.broadcast(track, {
            type: "occupant_leave",
            target: track.profile,
            nick: track.nick,
            room,
            cid,
            nickOut: person.username,
            occupant: person,
            total: entry.occupants.size,
            at: now(),
          });
          this.broadcast(track, this.roomMessage(track));
        }
        this.scheduleRefresh(track, room, false);
      }
    }
  }

  onState(event) {
    const cid = String(event.cid || "");
    if (!cid) return;
    let room = parseRoomId(event.room);
    if (!room) {
      for (const key of ["room", "room_id", "location", "current_room", "chat_room"]) {
        room = parseRoomId(event.props?.[key]);
        if (room) break;
      }
    }
    if (!room) return;
    for (const track of this.tracks.values()) {
      if (track.cid !== cid) continue;
      track.presenceRoom = room;
      track.presenceRoomAt = now();
      track.lastImqRoomAt = now();
      const existing = track.rooms.get(room);
      if (existing) {
        existing.lastSeenAt = now();
      } else {
        this.log.info(`[IMQ] ${track.nick} (${track.cid}): state aponta para sala ${room}`);
        this.scheduleRoomLoad(track, room, "presence", { immediate: true });
      }
    }
  }

  scheduleRoomLoad(track, rid, source, { immediate = false } = {}) {
    if (this.tracks.get(track.cid) !== track) return;
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return;
    if (track.rooms.has(id)) {
      track.rooms.get(id).lastSeenAt = now();
      return;
    }
    if (track.pendingRoomLoads.has(id)) return;
    const timer = setTimeout(() => {
      track.pendingRoomLoads.delete(id);
      if (this.tracks.get(track.cid) !== track) return;
      this.setRoom(track, id, { via: source, gen: track.gen }).catch((error) => {
        this.log.warn(`[tracker] setRoom(${id}) falhou: ${error?.message || error}`);
      });
    }, immediate ? 0 : 300);
    track.pendingRoomLoads.set(id, { timer, source });
  }

  scheduleRefresh(track, rid, notify = false) {
    if (this.tracks.get(track.cid) !== track) return;
    const id = String(rid || track.room?.roomId || "");
    if (!id) return;
    const previous = track.refreshTimers.get(id);
    const shouldNotify = Boolean(previous?.notify || notify);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      track.refreshTimers.delete(id);
      if (this.tracks.get(track.cid) !== track) return;
      this.refreshRoomById(track, id, { notify: shouldNotify }).catch(() => {});
    }, 450);
    track.refreshTimers.set(id, { timer, notify: shouldNotify });
  }

  // ---------------- alertas Web Push ----------------

  validSubscription(subscription) {
    const endpoint = String(subscription?.endpoint || "");
    return (
      endpoint.startsWith("https://") &&
      endpoint.length < 1_200 &&
      typeof subscription?.keys?.p256dh === "string" &&
      subscription.keys.p256dh.length > 20 &&
      typeof subscription?.keys?.auth === "string" &&
      subscription.keys.auth.length > 5
    );
  }

  alertUrl(track) {
    return `${SITE_URL}/?nick=${encodeURIComponent(track.profile.username || track.nick)}`;
  }

  sendPushToAlert(alert, payload) {
    if (!pushAvailable() || !alert || alert.expiresAt <= now()) return;
    const body = {
      title: payload.title || "IMVU Radar",
      body: payload.body || "",
      tag: payload.tag || `imvu-radar-${alert.track.cid}`,
      url: this.alertUrl(alert.track),
      icon: "/icons/icon-192.png",
    };
    sendPush(alert.subscription, body).catch((error) => {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        this.removeAlert(alert);
        return;
      }
      this.log.warn(`[push] falha ${error?.statusCode || ""}: ${error?.message || error}`);
    });
  }

  pushTrack(track, payload) {
    if (!pushAvailable() || !track.alerts?.size) return;
    for (const alert of [...track.alerts.values()]) {
      if (payload.occupants && !alert.settings.occupants) continue;
      this.sendPushToAlert(alert, payload);
    }
  }

  removeAlert(alert, { destroyIfEmpty = true } = {}) {
    if (!alert) return;
    if (alert.timer) clearTimeout(alert.timer);
    if (alert.welcomeTimer) clearTimeout(alert.welcomeTimer);
    this.alerts.delete(alert.endpoint);
    alert.track.alerts.delete(alert.endpoint);
    if (destroyIfEmpty && alert.track.watchers.size === 0 && alert.track.alerts.size === 0) {
      this.destroyTrack(alert.track);
    }
  }

  expireAlert(alert) {
    if (!this.alerts.has(alert.endpoint)) return;
    this.sendPushToAlert(alert, {
      title: "Alertas expiraram",
      body: `Os alertas de ${alert.track.profile.displayName || alert.track.nick} terminaram. Ative de novo no site.`,
      tag: `alert-expired-${alert.track.cid}`,
    });
    this.removeAlert(alert);
  }

  async startAlert(message) {
    const nick = safeNick(message?.nick);
    const subscription = message?.subscription;
    const settings = { occupants: Boolean(message?.settings?.occupants) };
    if (!nick) throw new Error("nick obrigatorio");
    if (!this.validSubscription(subscription)) throw new Error("subscription invalida");
    if (!pushAvailable()) throw new Error("push nao configurado no servidor");

    const endpoint = subscription.endpoint;
    const existing = this.alerts.get(endpoint);
    if (existing) this.removeAlert(existing);
    if (!existing && this.alerts.size >= MAX_ALERTS) {
      throw new Error("limite de alertas atingido");
    }

    const logged = await this.ensureLogin();
    if (!logged) throw new Error(this.api.lastError || "falha no login do IMVU");
    const profile = await this.api.resolve(nick);
    if (!profile) throw new Error(`nick "${nick}" nao encontrado`);

    let track = this.tracks.get(profile.cid);
    const isNewTrack = !track;
    if (!track) {
      track = this.createTrack(profile);
      this.tracks.set(profile.cid, track);
    }

    const alert = {
      endpoint,
      subscription,
      settings,
      track,
      createdAt: now(),
      expiresAt: now() + ALERT_TTL_MS,
      timer: null,
      welcomeTimer: null,
    };
    track.alerts.set(endpoint, alert);
    this.alerts.set(endpoint, alert);
    alert.timer = setTimeout(() => this.expireAlert(alert), ALERT_TTL_MS);

    if (isNewTrack) {
      this.imq.addTarget(profile.cid);
      this.startTimers(track);
      this.startSync(track);
    }

    if (track.room) {
      this.sendPushToAlert(alert, {
        title: "Sala atual",
        body: `${track.profile.displayName || track.nick} • ${track.room.name || track.room.roomId}${track.room.privacy === "private" ? " (privada)" : ""}`,
        tag: `room-${track.room.roomId}`,
      });
    } else {
      alert.welcomeTimer = setTimeout(() => {
        if (!this.alerts.has(endpoint) || track.room) return;
        this.sendPushToAlert(alert, {
          title: "Alertas ativados",
          body: `Vigiando ${track.profile.displayName || track.nick}. Aviso quando entrar em uma sala.`,
          tag: `alert-on-${track.cid}`,
        });
      }, 6_000);
    }

    this.log.info(`[push] alerta ativado para ${track.nick} (${track.cid}) expira em ${Math.round(ALERT_TTL_MS / 60_000)}min`);
    return {
      nick: track.profile.username || track.nick,
      displayName: track.profile.displayName || track.nick,
      cid: track.cid,
      expiresAt: alert.expiresAt,
      mode: "push",
    };
  }

  stopAlert(message) {
    const endpoint = String(message?.endpoint || "");
    if (!endpoint) return;
    const alert = this.alerts.get(endpoint);
    if (alert) this.removeAlert(alert);
  }

  testAlert(message) {
    const endpoint = String(message?.endpoint || "");
    if (!endpoint) return;
    const alert = this.alerts.get(endpoint);
    if (!alert) return;
    this.sendPushToAlert(alert, {
      title: "Teste de alerta",
      body: "Se você recebeu esta notificação, o push está funcionando.",
      tag: `test-${now()}`,
    });
  }

  stats() {
    let watchers = 0;
    for (const track of this.tracks.values()) watchers += track.watchers.size;
    return {
      loggedIn: this.api.loggedIn,
      imqReady: this.imq.ready,
      botCid: this.api.cid || "",
      tracks: this.tracks.size,
      watchers,
      alerts: this.alerts.size,
      rooms: this.roomRefs.size,
      lastError: this.api.lastError,
    };
  }
}

export { sleep };
