import { ImvuApi, safeNick } from "./imvu.js";
import { ImqClient, isLeftAction, isLiveAction } from "./imq.js";
import {
  findRooms as catvuFind,
  fetchRoomSnapshot as catvuRoomSnapshot,
  watchRoom as catvuWatch,
  catvuPerson,
} from "./catvu.js";
import { sendPush, pushAvailable } from "./push.js";

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const LIST_DEADLINE_MS = envInt("LIST_SCAN_DEADLINE_MS", 15_000);
const OWN_ROOM_SCAN = envInt("OWN_ROOM_SCAN", 120);
const OWN_DEADLINE_MS = envInt("OWN_SCAN_DEADLINE_MS", 12_000);
const CATVU_RETRY_MS = envInt("CATVU_RETRY_MS", 20_000);
const TARGET_ROOM_SCAN = envInt("TARGET_ROOM_SCAN", 800);
const PROBE_INTERVAL_MS = envInt("PROBE_INTERVAL_MS", 15_000);
const PROBE_TIMEOUT_MS = envInt("PROBE_TIMEOUT_MS", 12_000);
const ROOM_REFRESH_MS = envInt("ROOM_REFRESH_MS", 20_000);
const ALERT_TTL_MS = envInt("ALERT_TTL_MS", 2 * 60 * 60 * 1000);
const MAX_ALERTS = envInt("MAX_ALERTS", 30);
const SITE_URL = String(process.env.SITE_URL || "https://imvu-radar-web.netlify.app").replace(/\/+$/, "");

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      room: null,
      occupants: new Map(),
      state: "loading",
      statusMsg: "Procurando sala atual...",
      detectedBy: "",
      gen: 0,
      lastLive: new Set(),
      myRoomStreak: 0,
      probeInFlight: null,
      roomLoadTimer: null,
      pendingRoom: "",
      refreshTimer: null,
      refreshNotify: false,
      probeTimer: null,
      refreshLoopTimer: null,
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
        if (track.room) return;
        this.probeTick(track).catch((error) => {
          this.log.warn(`[tracker] probe(${track.cid}) falhou: ${error?.message || error}`);
        });
      }, PROBE_INTERVAL_MS);
    }
    if (!track.refreshLoopTimer) {
      track.refreshLoopTimer = setInterval(() => {
        if (this.tracks.get(track.cid) !== track) return;
        this.syncCurrentRoom(track).catch(() => {});
        if (!track.room) return;
        this.refreshRoom(track, { notify: false }).catch(() => {});
      }, ROOM_REFRESH_MS);
    }
  }

  clearTrackTimers(track) {
    if (track.probeTimer) clearInterval(track.probeTimer);
    if (track.refreshLoopTimer) clearInterval(track.refreshLoopTimer);
    if (track.roomLoadTimer) clearTimeout(track.roomLoadTimer);
    if (track.refreshTimer) clearTimeout(track.refreshTimer);
    track.probeTimer = null;
    track.refreshLoopTimer = null;
    track.roomLoadTimer = null;
    track.refreshTimer = null;
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
    if (track.room) this.releaseRoom(track.room.roomId);
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

  roomMessage(track) {
    const room = track.room
      ? {
          ...track.room,
          occupancy: Math.max(Number(track.room.occupancy) || 0, track.occupants.size),
          total: track.occupants.size,
        }
      : null;
    return {
      type: "room",
      target: track.profile,
      nick: track.nick,
      room,
      occupants: this.occupantList(track),
      total: track.occupants.size,
      detectedBy: track.detectedBy,
      at: now(),
    };
  }

  sendCurrent(client, track) {
    client.send(this.watchingMessage(track));
    if (track.room) {
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
    const cid = track.cid;
    const active = () => this.isActive(track, gen);

    // 0) Fonte direta do IMVU: relations.current_room do node do usuario.
    // Funciona com o alvo parado e nao depende do catvu.
    this.emitStatus(track, "loading", "Lendo sala atual no IMVU...");
    const relationRoom = await this.api.currentRoom(cid, 0).catch(() => "");
    if (!active()) return;
    if (relationRoom) {
      await this.setRoom(track, relationRoom, { via: "user_relation", gen });
      return;
    }

    // Catvu entra como fallback: e a fonte que devolve a sala ATUAL do alvo
    // mesmo quando ele esta parado (inclusive sala privada).
    track.catvuLastTry = now();
    // Force no inicio: evita usar cache de uma sala anterior do mesmo nick.
    const catvuPromise = catvuFind(track.nick, { timeout: 10_000, force: true }).catch(() => null);

    // 1) Lista de amigos do bot: o IMVU ja denormaliza a sala atual de cada amigo.
    try {
      const hints = await this.api.friendsRoomHints();
      for (const hint of hints) {
        if (!active()) return;
        const people = await this.api.roster(hint.rid, 2_000);
        if (people.some((person) => person.cid === cid)) {
          await this.setRoom(track, hint.rid, { seed: people, via: "friends", gen });
          return;
        }
      }
    } catch {
      /* sem lista de amigos acessivel */
    }
    if (!active()) return;

    // 2) Catvu find: sala exata, sem depender de evento de movimento.
    this.emitStatus(track, "loading", "Consultando indice de salas (catvu)...");
    const catvu = await catvuPromise;
    if (catvu?.rooms?.length) {
      this.emitStatus(track, "loading", "Catvu: sala localizada, lendo ocupantes...");
      if (await this.applyCatvuResult(track, catvu, gen)) return;
    }
    if (!active()) return;

    // 3) Listas oficiais: friends / recent / explore.
    this.emitStatus(track, "loading", "Varrendo listas oficiais...");
    const listHits = await this.api.findInLists(cid, ["friends", "recent", "explore"], {
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
      return;
    }

    // 4) Salas proprias do alvo com ocupacao > 0.
    this.emitStatus(track, "loading", "Varrendo salas do alvo...");
    const ownHits = await this.api.findInOwnRooms(cid, OWN_ROOM_SCAN, {
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
      return;
    }

    // 5) Probe do IMQ: filas chat-<cid>-* vivas.
    this.emitStatus(track, "loading", "Sondando canais em tempo real...");
    await this.probeTick(track);
    if (!active() || track.room) return;

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

  async syncCurrentRoom(track) {
    if (this.tracks.get(track.cid) !== track) return false;
    const rid = await this.api.currentRoom(track.cid, 5_000).catch(() => "");
    if (!rid) return false;
    if (track.room?.roomId === rid) return true;
    await this.setRoom(track, rid, { via: "user_relation", gen: track.gen });
    return true;
  }

  async probeTick(track) {
    if (this.tracks.get(track.cid) !== track) return;
    if (track.probeInFlight) return track.probeInFlight;
    track.probeInFlight = (async () => {
      // Primeiro tenta a relation current_room do IMVU (uma request barata).
      if (!track.room) {
        const relationRoom = await this.api.currentRoom(track.cid, 5_000).catch(() => "");
        if (this.tracks.get(track.cid) !== track) return;
        if (relationRoom) {
          await this.setRoom(track, relationRoom, { via: "user_relation", gen: track.gen });
          return;
        }
      }

      // Rechecagem periodica do catvu: se o alvo entrou/esta parado numa sala
      // que o evento do IMQ nao cobriu, o find devolve o roomId exato.
      if (!track.room && now() - (track.catvuLastTry || 0) > CATVU_RETRY_MS) {
        track.catvuLastTry = now();
        const result = await catvuFind(track.nick, { timeout: 8_000 }).catch(() => null);
        if (this.tracks.get(track.cid) !== track) return;
        if (result && (await this.applyCatvuResult(track, result, track.gen))) return;
      }

      const live = await this.imq.probeQueues(track.cid, PROBE_TIMEOUT_MS);
      if (this.tracks.get(track.cid) !== track) return;
      if (track.room) return;
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

    // 1) Confirma pelo roster quando ainda nao temos nenhuma leitura anterior.
    if (track.lastLive.size === 0) {
      for (const rid of own.slice(0, 6)) {
        const people = await this.api.roster(rid, 0).catch(() => []);
        if (this.tracks.get(track.cid) !== track || track.room) return;
        if (people.some((person) => person.cid === track.cid)) {
          await this.setRoom(track, rid, { seed: people, via: "probe_roster", gen: track.gen });
          return;
        }
      }
    }

    // 2) Sala nova que apareceu entre dois probes.
    if (track.lastLive.size > 0) {
      const fresh = own.filter((rid) => !track.lastLive.has(rid));
      if (fresh.length === 1) {
        await this.setRoom(track, fresh[0], { via: "imq_new", gen: track.gen });
        return;
      }
    }

    // 3) My Room (<cid>-1) viva em dois probes seguidos.
    if (own.includes(`${track.cid}-1`)) {
      track.myRoomStreak += 1;
      if (track.myRoomStreak >= 2) {
        await this.setRoom(track, `${track.cid}-1`, { via: "myroom", gen: track.gen });
        return;
      }
    } else {
      track.myRoomStreak = 0;
    }

    // 4) Uma unica sala privada viva.
    if (own.length === 1) {
      await this.setRoom(track, own[0], { via: "imq_probe", gen: track.gen });
      return;
    }

    track.lastLive = new Set(own);
  }

  // ---------------- sala e ocupantes ----------------

  acquireRoom(rid) {
    const count = this.roomRefs.get(rid) || 0;
    this.roomRefs.set(rid, count + 1);
    if (count === 0) this.imq.addRoom(rid);
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
    if (!/^\d+-\d+$/.test(String(rid || ""))) return;

    if (track.room?.roomId === rid) {
      await this.refreshRoom(track, { notify: true });
      return;
    }

    const [info, people] = await Promise.all([
      this.api.roomInfo(rid, hint).catch(() => null),
      seed ? Promise.resolve(seed) : this.api.roster(rid, 0).catch(() => []),
    ]);
    if (!this.isActive(track, gen)) return;

    const hintPrivate = Boolean(hint?.isPrivate ?? hint?.is_private);
    const suffix = String(rid).split("-").pop();
    const fallbackName = hint?.name || (suffix === "1" ? "My Room" : `Sala ${rid}`);
    const room = info || {
      roomId: rid,
      name: fallbackName,
      privacy: hintPrivate ? "private" : "public",
      privacyLabel: hintPrivate ? "Privada" : "Pública",
      restricted: hintPrivate,
      owner: "",
      occupancy: 0,
      capacity: 0,
      render: "",
      cover: "",
      description: "",
      joinUrl: `https://go.imvu.com/chat/room-${rid}`,
      directLink: "",
      webLink: `https://www.imvu.com/next/chat/room-${rid}/`,
      error: "",
      message: "",
      source: hint ? "catvu" : "imvu",
    };

    if (track.room?.roomId && track.room.roomId !== rid) {
      this.releaseRoom(track.room.roomId);
    }
    this.acquireRoom(rid);

    const previousRoom = track.room;
    track.room = room;
    track.detectedBy = via;
    track.occupants = this.buildOccupants(track, people);
    track.catvuSnapshotAt = 0;
    track.catvuSnapshotLoading = false;
    track.pendingJoins.clear();
    track.state = "online";
    track.statusMsg = `Na sala ${room.name}`;
    track.lastLive = new Set();
    track.myRoomStreak = 0;

    const needsCatvuWatch =
      room.privacy === "private" ||
      room.restricted ||
      people.length === 0 ||
      via.startsWith("catvu_private");
    if (needsCatvuWatch) {
      this.loadCatvuSnapshot(track, rid).catch(() => {});
    }

    this.broadcast(track, this.roomMessage(track));
    this.broadcast(track, this.statusMessage(track, "online", `Na sala ${room.name}`));
    this.log.info(`[tracker] ${track.nick} -> ${room.name} (${rid}) via ${via}`);

    if (track.alerts.size) {
      this.pushTrack(track, {
        title: previousRoom?.roomId && previousRoom.roomId !== rid ? "Mudou de sala" : "Está na sala",
        body: `${track.profile.displayName || track.nick} • ${room.name}${room.privacy === "private" ? " (privada)" : ""}`,
        tag: `room-${rid}`,
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

  emitOccupantJoin(track, person) {
    this.broadcast(track, {
      type: "occupant_join",
      target: track.profile,
      nick: track.nick,
      room: track.room?.roomId || track.catvuRoomId,
      cid: person.cid,
      occupant: person,
      total: track.occupants.size,
      at: now(),
    });
    if (track.alerts.size) {
      this.pushTrack(track, {
        title: "Entrou na sala",
        body: `${person.displayName || person.username} entrou em ${track.room?.name || "sala"}`,
        tag: `join-${person.cid}-${now()}`,
        occupants: true,
      });
    }
  }

  emitOccupantLeave(track, person) {
    this.broadcast(track, {
      type: "occupant_leave",
      target: track.profile,
      nick: track.nick,
      room: track.room?.roomId || track.catvuRoomId,
      cid: person.cid,
      nickOut: person.username,
      occupant: person,
      total: track.occupants.size,
      at: now(),
    });
    if (track.alerts.size) {
      this.pushTrack(track, {
        title: "Saiu da sala",
        body: `${person.displayName || person.username} saiu de ${track.room?.name || "sala"}`,
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
    if (process.env.RENDER === "true") {
      track.catvuSnapshotAt = now();
      return;
    }
    if (this.tracks.get(track.cid) !== track || track.room?.roomId !== rid) return;
    if (track.catvuSnapshotLoading) return;
    if (track.catvuSnapshotAt && now() - track.catvuSnapshotAt < 15_000) return;
    track.catvuSnapshotLoading = true;
    try {
      const snapshot = await catvuRoomSnapshot(rid, track.nick, { timeout: 30_000 });
      if (this.tracks.get(track.cid) !== track || track.room?.roomId !== rid) return;

      if (snapshot?.room?.name) {
        const currentName = String(track.room.name || "");
        if (!currentName || currentName === rid || currentName.startsWith("Sala ")) {
          track.room = { ...track.room, name: snapshot.room.name };
        }
      }
      if (snapshot?.room?.isPrivate && track.room.privacy !== "private") {
        track.room = { ...track.room, privacy: "private", privacyLabel: "Privada" };
      }

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
        this.applyCatvuPeople(track, people, { initial: true });
        this.enrichOccupants(track, people.map((person) => person.cid)).catch(() => {});
      }

      track.catvuSnapshotAt = now();
      if (snapshot?.room?.name) this.broadcast(track, this.roomMessage(track));
    } catch (error) {
      this.log.warn(`[catvu] snapshot ${rid} falhou: ${error?.message || error}`);
      track.catvuSnapshotAt = now();
    } finally {
      track.catvuSnapshotLoading = false;
    }
  }

  /** Completa os ocupantes do catvu com o avatar 2D do IMVU (api.imvu.com). */
  async enrichOccupants(track, cids) {
    const rid = track.room?.roomId;
    const unique = [...new Set((cids || []).filter((cid) => /^\d+$/.test(String(cid))))];
    let index = 0;
    const workers = Array.from({ length: Math.min(4, unique.length || 1) }, async () => {
      while (true) {
        const i = index++;
        if (i >= unique.length) return;
        if (this.tracks.get(track.cid) !== track || track.room?.roomId !== rid) return;
        const cid = unique[i];
        const current = track.occupants.get(cid);
        if (!current || current.avatarPortrait) continue;
        const person = await this.api.resolveCid(cid).catch(() => null);
        if (!person) continue;
        if (this.tracks.get(track.cid) !== track || track.room?.roomId !== rid) return;
        const existing = track.occupants.get(cid);
        if (!existing) continue;
        track.occupants.set(cid, this.mergeOccupant(existing, occupantFromPerson(person)));
      }
    });
    await Promise.all(workers);
    if (this.tracks.get(track.cid) === track) {
      this.broadcast(track, this.roomMessage(track));
    }
  }

  applyCatvuPeople(track, people, { initial = false } = {}) {
    const rid = track.room?.roomId || track.catvuRoomId;
    if (!rid) return;
    const old = track.occupants;
    const next = new Map();
    next.set(track.cid, old.get(track.cid) || occupantFromPerson(track.profile));

    for (const person of people) {
      if (!person?.cid) continue;
      const incoming = occupantFromPerson(person);
      next.set(person.cid, this.mergeOccupant(old.get(person.cid), incoming));
    }

    track.occupants = next;

    if (!initial) {
      for (const person of next.values()) {
        if (person.cid === track.cid) continue;
        if (!old.has(person.cid)) this.emitOccupantJoin(track, person);
      }
      for (const person of old.values()) {
        if (person.cid === track.cid) continue;
        if (!next.has(person.cid)) this.emitOccupantLeave(track, person);
      }
    }

    this.broadcast(track, this.roomMessage(track));
  }

  applyCatvuJoin(track, person) {
    if (person.cid === track.cid) return;
    const previous = track.occupants.get(person.cid);
    const occupant = this.mergeOccupant(previous, occupantFromPerson(person));
    track.occupants.set(person.cid, occupant);
    if (!previous) this.emitOccupantJoin(track, occupant);
    this.broadcast(track, this.roomMessage(track));
  }

  applyCatvuLeave(track, person) {
    if (person.cid === track.cid) return;
    const existing = track.occupants.get(person.cid);
    if (!existing) return;
    track.occupants.delete(person.cid);
    this.emitOccupantLeave(track, existing);
    this.broadcast(track, this.roomMessage(track));
  }

  /**
   * Evento edge:participants de quem entrou numa sala que estamos vigiando.
   * Resolve o cid no IMVU e adiciona na hora — funciona mesmo quando o
   * roster HTTP da sala privada vem 403.
   */
  async ensureOccupant(track, cid) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return;
    if (this.tracks.get(track.cid) !== track || !track.room) return;
    if (id === track.cid) return;
    if (track.occupants.has(id) || track.pendingJoins.has(id)) return;

    track.pendingJoins.add(id);
    try {
      const person = await this.api.resolveCid(id).catch(() => null);
      if (this.tracks.get(track.cid) !== track || !track.room) return;
      if (track.occupants.has(id)) return;
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
      track.occupants.set(id, occupant);
      this.emitOccupantJoin(track, occupant);
      this.broadcast(track, this.roomMessage(track));
    } finally {
      track.pendingJoins.delete(id);
    }
  }

  clearRoom(track, reason = "left") {
    if (!track.room) return;
    this.stopCatvuWatch(track);
    const oldRoom = track.room;
    this.releaseRoom(oldRoom.roomId);
    track.room = null;
    track.occupants.clear();
    track.catvuSnapshotAt = 0;
    track.catvuSnapshotLoading = false;
    track.pendingJoins.clear();
    track.detectedBy = "";
    track.state = "offline";
    track.statusMsg = "Fora de sala. Monitorando em tempo real...";

    this.broadcast(track, {
      type: "room_leave",
      target: track.profile,
      nick: track.nick,
      room: oldRoom,
      reason,
      message: "Saiu da sala",
      at: now(),
    });
    this.broadcast(track, this.statusMessage(track, "offline", track.statusMsg));
    if (track.alerts.size) {
      this.pushTrack(track, {
        title: "Saiu da sala",
        body: `${track.profile.displayName || track.nick} saiu de ${oldRoom.name}`,
        tag: `left-${oldRoom.roomId}`,
      });
    }

    // Pode ter trocado de sala direto; uma sondagem curta resolve.
    setTimeout(() => {
      if (this.tracks.get(track.cid) === track && !track.room) {
        this.probeTick(track).catch(() => {});
      }
    }, 2_500);
  }

  async refreshRoom(track, { notify = false } = {}) {
    const rid = track.room?.roomId;
    if (!rid) return;
    const [info, people] = await Promise.all([
      this.api.roomInfo(rid, track.room).catch(() => null),
      this.api.roster(rid, 0).catch(() => []),
    ]);
    if (track.room?.roomId !== rid) return;

    if (info) {
      track.room = {
        ...track.room,
        ...info,
        name: info.name || track.room.name,
        occupancy: Math.max(Number(info.occupancy) || 0, people.length),
      };
    }

    const needsPrivateFill = track.room.privacy === "private" || track.room.restricted;
    if (needsPrivateFill && (!track.catvuSnapshotAt || now() - track.catvuSnapshotAt > 60_000)) {
      this.loadCatvuSnapshot(track, rid).catch(() => {});
    }

    // Roster vazio pode ser falha transitória (403/timeout) em sala privada.
    // Nesse caso preserva o snapshot anterior em vez de sumir com todo mundo.
    if (!people.length && track.occupants.size > 1) {
      if (notify) this.broadcast(track, this.roomMessage(track));
      return;
    }

    const old = track.occupants;
    const next = this.buildOccupants(track, people);
    const joins = [...next.values()].filter((person) => person.cid !== track.cid && !old.has(person.cid));
    const leaves = [...old.values()].filter((person) => person.cid !== track.cid && !next.has(person.cid));
    track.occupants = next;

    if (notify) {
      for (const person of joins) {
        this.broadcast(track, {
          type: "occupant_join",
          target: track.profile,
          nick: track.nick,
          room: rid,
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
          room: rid,
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
        this.log.info("[tracker] IMQ pronto");
        break;
      case "imq_error":
        this.log.warn(`[tracker] erro IMQ: ${event.message}`);
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
          if (track.room?.roomId !== room) {
            this.scheduleRoomLoad(track, room, "imq");
          }
        } else if (isLeftAction(action)) {
          if (track.room?.roomId === room) {
            this.clearRoom(track, "left");
          }
        }
        continue;
      }

      if (track.room?.roomId !== room) continue;

      if (isLiveAction(action)) {
        this.ensureOccupant(track, cid).catch(() => {});
        this.scheduleRefresh(track, true);
      } else if (isLeftAction(action)) {
        const person = track.occupants.get(cid);
        if (person) {
          track.occupants.delete(cid);
          this.broadcast(track, {
            type: "occupant_leave",
            target: track.profile,
            nick: track.nick,
            room,
            cid,
            nickOut: person.username,
            occupant: person,
            total: track.occupants.size,
            at: now(),
          });
          this.broadcast(track, this.roomMessage(track));
        }
        this.scheduleRefresh(track, false);
      }
    }
  }

  onState(event) {
    const cid = String(event.cid || "");
    if (!cid) return;
    let room = "";
    for (const key of ["room", "room_id", "location", "current_room", "chat_room"]) {
      const value = String(event.props?.[key] || "");
      if (/^\d+-\d+$/.test(value)) {
        room = value;
        break;
      }
    }
    if (!room) return;
    for (const track of this.tracks.values()) {
      if (track.cid !== cid) continue;
      if (track.room?.roomId !== room) this.scheduleRoomLoad(track, room, "presence");
    }
  }

  scheduleRoomLoad(track, rid, source) {
    if (this.tracks.get(track.cid) !== track) return;
    if (track.roomLoadTimer && track.pendingRoom === rid) return;
    if (track.roomLoadTimer) clearTimeout(track.roomLoadTimer);
    track.pendingRoom = rid;
    track.roomLoadTimer = setTimeout(() => {
      track.roomLoadTimer = null;
      const target = track.pendingRoom;
      track.pendingRoom = "";
      if (!target || this.tracks.get(track.cid) !== track) return;
      this.setRoom(track, target, { via: source, gen: track.gen }).catch((error) => {
        this.log.warn(`[tracker] setRoom(${target}) falhou: ${error?.message || error}`);
      });
    }, 300);
  }

  scheduleRefresh(track, notify) {
    if (this.tracks.get(track.cid) !== track) return;
    track.refreshNotify = track.refreshNotify || Boolean(notify);
    if (track.refreshTimer) clearTimeout(track.refreshTimer);
    track.refreshTimer = setTimeout(() => {
      track.refreshTimer = null;
      const shouldNotify = track.refreshNotify;
      track.refreshNotify = false;
      if (this.tracks.get(track.cid) !== track) return;
      this.refreshRoom(track, { notify: shouldNotify }).catch(() => {});
    }, 450);
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
    if (existing) this.removeAlert(existing, { destroyIfEmpty: false });
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
        body: `${track.profile.displayName || track.nick} • ${track.room.name}${track.room.privacy === "private" ? " (privada)" : ""}`,
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
