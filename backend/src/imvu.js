import { setTimeout as delay } from "node:timers/promises";

export const API = "https://api.imvu.com";
export const WS_URL = "wss://wss-imq.imvu.com/streaming/imvu_pre";
export const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ROOM_META_TTL = 15_000;
const ROSTER_TTL = 6_000;
const ROOM_LIST_TTL = 20_000;
const USER_TTL = 10 * 60_000;
const IMAGE_TTL = 10 * 60_000;
const IMAGE_CACHE_MAX = 250;

const now = () => Date.now();

function normalizeUrl(value) {
  const s = String(value || "");
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

function roomIdFromUrl(value) {
  const m = /room-(\d+-\d+)\s*$/.exec(String(value || ""));
  return m ? m[1] : "";
}

function cidFromUserUrl(value) {
  const m = /user-(\d+)\s*$/.exec(String(value || ""));
  return m ? m[1] : "";
}

function intOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function safeNick(value) {
  return String(value || "")
    .replace(/^@+/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 64);
}

/** Mesma forma que URLEncoder.encode do Kotlin: espacos viram '+'. */
export function encodeQuery(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

export class ImvuApi {
  constructor({ username, password, ua = UA, log = console } = {}) {
    this.username = String(username || "");
    this.password = String(password || "");
    this.ua = ua;
    this.log = log;

    this.cookies = new Map();
    this.sauce = "";
    this.cid = "";
    this.sessionId = "";
    this.displayName = "";
    this.loggedIn = false;
    this.lastError = "";
    this.loginPromise = null;

    this.userCache = new Map();
    this.userNodeCache = new Map();
    this.roomMetaCache = new Map();
    this.rosterCache = new Map();
    this.roomListCache = new Map();
    this.imageCache = new Map();
    this.catvuCache = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  applyCookies(response) {
    let list = [];
    try {
      list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    } catch {
      list = [];
    }
    if (!list.length) {
      const single = response.headers.get("set-cookie");
      if (single) list = [single];
    }
    for (const header of list) {
      const first = String(header).split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) {
        this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    }
  }

  async raw(path, { method = "GET", body = null, withSauce = false, timeout = 25_000 } = {}) {
    if (!path.startsWith("/")) throw new Error("path invalido");
    const headers = {
      "User-Agent": this.ua,
      Accept: "application/json",
      Origin: "https://www.imvu.com",
      Referer: "https://www.imvu.com/",
    };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (this.sauce && (withSauce || this.loggedIn)) {
      headers["x-imvu-sauce"] = this.sauce;
      headers["x-imvu-application"] = "next_desktop/1";
    }
    if (body !== null && body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    try {
      const response = await fetch(API + path, {
        method,
        headers,
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      this.applyCookies(response);
      return { status: response.status, text: await response.text() };
    } catch (error) {
      this.lastError = error?.message || String(error);
      return null;
    }
  }

  async getJson(path, opts = {}) {
    const result = await this.raw(path, opts);
    if (!result) return null;
    if (result.status < 200 || result.status > 299) return null;
    try {
      return JSON.parse(result.text);
    } catch {
      return null;
    }
  }

  firstNode(env, predicate = null) {
    const den = env?.denormalized;
    if (!den || typeof den !== "object") return null;
    for (const [key, node] of Object.entries(den)) {
      if (!node || typeof node !== "object") continue;
      if (!node.data) continue;
      if (predicate && !predicate(key, node)) continue;
      return { key, node };
    }
    return null;
  }

  personFromData(cid, data) {
    const d = data || {};
    return {
      cid: String(cid || ""),
      username: String(d.username || cid || ""),
      displayName: String(d.display_name || d.username || cid || ""),
      avatar: normalizeUrl(d.thumbnail_url || d.avatar_image || ""),
      render: normalizeUrl(d.avatar_image || ""),
      portrait: normalizeUrl(d.avatar_portrait_image || ""),
      isVip: Boolean(d.is_vip),
      isAp: Boolean(d.is_ap),
      online: Boolean(d.online),
    };
  }

  async login() {
    this.lastError = "";
    if (!this.username || !this.password) {
      this.lastError = "IMVU_USER/IMVU_PASS nao configurados";
      return false;
    }
    const response = await this.raw("/login", {
      method: "POST",
      body: {
        gdpr_cookie_acceptance: true,
        username: this.username,
        password: this.password,
        remember_device: true,
      },
      timeout: 30_000,
    });
    if (!response) {
      this.lastError = this.lastError || "falha de rede no login";
      return false;
    }
    if (response.status < 200 || response.status > 299) {
      this.lastError = `login recusado (HTTP ${response.status})`;
      return false;
    }
    let env;
    try {
      env = JSON.parse(response.text);
    } catch {
      this.lastError = "login devolveu resposta invalida";
      return false;
    }
    if (env?.status !== "success") {
      this.lastError = "login negado";
      return false;
    }
    const node = this.firstNode(env);
    const sauce = node?.node?.data?.sauce;
    if (!sauce) {
      this.lastError = "resposta sem sauce";
      return false;
    }
    this.sauce = String(sauce);

    const me = await this.getJson("/login/me", { withSauce: true });
    if (!me) {
      this.lastError = "sessao (/login/me) falhou";
      return false;
    }
    const meNode = this.firstNode(me);
    const cid = meNode?.node?.relations?.quick_chat_profile;
    const sessionId = meNode?.node?.data?.session_id;
    if (!cid || !sessionId) {
      this.lastError = "sessao invalida (cid/session ausentes)";
      return false;
    }
    this.cid = String(cid);
    this.sessionId = String(sessionId);
    this.loggedIn = true;
    this.log.info(`[imvu] login ok cid=${this.cid} session=${this.sessionId.slice(0, 6)}...`);
    return true;
  }

  async ensureLogin() {
    if (this.loggedIn && this.cid && this.sessionId) return true;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async resolve(nick) {
    const clean = safeNick(nick);
    if (!clean) return null;
    const env = await this.getJson("/user?username=" + encodeURIComponent(clean));
    const den = env?.denormalized;
    if (!den) return null;
    for (const [key, node] of Object.entries(den)) {
      if (!key.includes("/user/user-")) continue;
      const cid = cidFromUserUrl(key);
      if (!cid) continue;
      const person = this.personFromData(cid, node?.data);
      this.userCache.set(cid, { at: now(), person });
      return person;
    }
    return null;
  }

  async resolveCid(cid) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return null;
    const cached = this.userCache.get(id);
    if (cached && now() - cached.at < USER_TTL) return cached.person;
    const env = await this.getJson(`/user/user-${id}`);
    const den = env?.denormalized;
    if (!den) return null;
    for (const [key, node] of Object.entries(den)) {
      if (!key.endsWith(`/user/user-${id}`) && !key.endsWith(`user-${id}`)) continue;
      if (!node?.data) continue;
      const person = this.personFromData(id, node.data);
      this.userCache.set(id, { at: now(), person });
      return person;
    }
    return null;
  }

  /**
   * Node completo de /user/user-<cid>, com as relations.
   * A relation `current_room` aponta para a sala ATUAL do usuario, mesmo
   * quando ele esta parado e mesmo que a sala seja privada.
   */
  async userNode(cid, ttl = 10_000) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return null;
    const cached = this.userNodeCache.get(id);
    if (cached && now() - cached.at < ttl) return cached.node;

    const env = await this.getJson(`/user/user-${id}`);
    const den = env?.denormalized;
    if (!den) return null;
    for (const [key, node] of Object.entries(den)) {
      if (!key.endsWith(`/user/user-${id}`) && !key.endsWith(`user-${id}`)) continue;
      if (!node) continue;
      const result = {
        relations: node.relations || {},
        data: node.data || {},
      };
      this.userNodeCache.set(id, { at: now(), node: result });
      if (result.data && result.data.username) {
        this.userCache.set(id, { at: now(), person: this.personFromData(id, result.data) });
      }
      return result;
    }
    return null;
  }

  /** cid -> roomId atual via relations.current_room ("" se nao estiver em sala). */
  async currentRoom(cid, ttl = 10_000) {
    const node = await this.userNode(cid, ttl);
    const url = String(node?.relations?.current_room || "");
    const match = /room-(\d+-\d+)\s*$/i.exec(url) || /(\d+-\d+)\s*$/.exec(url);
    return match ? match[1] : "";
  }

  async usernameOf(cid) {
    const person = await this.resolveCid(cid);
    return person?.username || String(cid || "");
  }

  async presence(cid) {
    const id = String(cid || "");
    if (!/^\d+$/.test(id)) return false;
    const env = await this.getJson(`/presence/presence-${id}`);
    const node = this.firstNode(env);
    return Boolean(node?.node?.data?.online);
  }

  async roomMeta(rid) {
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return null;
    const cached = this.roomMetaCache.get(id);
    if (cached && now() - cached.at < ROOM_META_TTL) return cached.meta;

    const result = await this.raw(`/room/room-${id}`);
    if (!result) return null;
    let meta = null;
    if (result.status < 200 || result.status > 299) {
      let error = "";
      let message = "";
      try {
        const j = JSON.parse(result.text);
        error = String(j.error || "");
        message = String(j.message || "");
      } catch {
        /* corpo nao-JSON */
      }
      meta = { roomId: id, restricted: true, error, message, name: "" };
    } else {
      try {
        const env = JSON.parse(result.text);
        const den = env?.denormalized || {};
        for (const node of Object.values(den)) {
          const d = node?.data;
          if (d && typeof d === "object" && d.name) {
            meta = { ...d, roomId: id, restricted: false };
            break;
          }
        }
      } catch {
        meta = null;
      }
    }
    if (!meta) return null;
    this.roomMetaCache.set(id, { at: now(), meta });
    return meta;
  }

  async roomInfo(rid, hint = null) {
    const id = String(rid || "");
    const meta = await this.roomMeta(id).catch(() => null);
    if (!meta && !hint) return null;

    const m = meta || {};
    const restricted = Boolean(m.restricted);
    const hintName = String(hint?.name || hint?.roomName || "");
    const hintPrivate = Boolean(
      hint?.isPrivate ?? hint?.is_private ?? String(hint?.privacy || "").toLowerCase() === "private"
    );
    let name = String(m.name || "") || hintName;
    if (!name) {
      const suffix = id.split("-").pop();
      name = restricted ? (suffix === "1" ? "My Room" : `Sala privada ${suffix}`) : id;
    }

    // O dono da sala e o primeiro cid do roomId; o node do usuario e publico
    // mesmo quando o room node vem 403 (sala privada de terceiro).
    let owner = String(m.owner_avatarname || "");
    if (!owner) {
      const head = id.split("-")[0];
      if (/^\d+$/.test(head)) {
        try {
          owner = await this.usernameOf(head);
        } catch {
          owner = "";
        }
      }
    }

    const isPrivate = restricted || hintPrivate || String(m.privacy || "").toLowerCase() === "private";
    const directLink =
      owner && name ? `imvu://room/${encodeQuery(owner)}/${encodeQuery(name)}` : "";
    const webLink = id ? `https://www.imvu.com/next/chat/room-${id}/` : "";

    return {
      roomId: id,
      name,
      privacy: isPrivate ? "private" : String(m.privacy || "public"),
      privacyLabel: isPrivate ? "Privada" : "Pública",
      restricted,
      owner,
      occupancy: intOr(m.occupancy, 0),
      capacity: intOr(m.capacity, 0),
      render: normalizeUrl(m.rendered_image || ""),
      cover: normalizeUrl(m.image_url || ""),
      description: String(m.description || "").slice(0, 300),
      joinUrl: String(m.join_room_url || (id ? `https://go.imvu.com/chat/room-${id}` : "")),
      directLink,
      webLink,
      error: String(m.error || ""),
      message: String(m.message || ""),
      source: hint ? "catvu" : "imvu",
    };
  }

  async roster(rid, ttl = ROSTER_TTL) {
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return [];
    const cached = this.rosterCache.get(id);
    if (cached && now() - cached.at < ttl) return cached.people;

    const env = await this.getJson(`/chat/chat-${id}/participants`);
    const den = env?.denormalized;
    const people = [];
    if (den) {
      let items = [];
      for (const [key, node] of Object.entries(den)) {
        if (key.endsWith("/participants")) {
          items = node?.data?.items || [];
        }
      }
      const seen = new Set();
      for (const item of items) {
        const itemNode = den[item] || {};
        const ref = itemNode?.relations?.ref || item;
        const cid = cidFromUserUrl(ref);
        if (!cid || seen.has(cid)) continue;
        const data = den[ref]?.data || itemNode?.data || {};
        const person = this.personFromData(cid, data);
        this.userCache.set(cid, { at: now(), person });
        seen.add(cid);
        people.push(person);
      }
    }
    this.rosterCache.set(id, { at: now(), people });
    return people;
  }

  async roomListRooms(listId) {
    if (!this.cid) return [];
    const key = String(listId || "");
    if (!/^[a-z_]+$/i.test(key)) return [];
    const cached = this.roomListCache.get(key);
    if (cached && now() - cached.at < ROOM_LIST_TTL) return cached.rids;

    const env = await this.getJson(`/room_list/room_list-${this.cid}-${key}/rooms`);
    const den = env?.denormalized;
    const rids = [];
    if (den) {
      let items = [];
      for (const [nodeKey, node] of Object.entries(den)) {
        if (nodeKey.endsWith("/rooms")) items = node?.data?.items || [];
      }
      const seen = new Set();
      for (const item of items) {
        const rid = roomIdFromUrl(item);
        if (!rid || seen.has(rid)) continue;
        seen.add(rid);
        rids.push(rid);
        const itemNode = den[item] || {};
        const ref = itemNode?.relations?.ref || "";
        const data = den[ref]?.data || {};
        if (data.name) {
          this.roomMetaCache.set(rid, {
            at: now(),
            meta: { ...data, roomId: rid, restricted: false },
          });
        }
      }
    }
    this.roomListCache.set(key, { at: now(), rids });
    return rids;
  }

  async friendsRoomHints() {
    if (!this.cid) return [];
    const env = await this.getJson(`/room_list/room_list-${this.cid}-friends/rooms`);
    const den = env?.denormalized;
    const out = [];
    if (!den) return out;
    let items = [];
    for (const [key, node] of Object.entries(den)) {
      if (key.endsWith("/rooms")) items = node?.data?.items || [];
    }
    for (const item of items) {
      const rid = roomIdFromUrl(item);
      if (!rid) continue;
      const itemNode = den[item] || {};
      const ref = itemNode?.relations?.ref || "";
      const data = den[ref]?.data || {};
      if (data.name) {
        this.roomMetaCache.set(rid, {
          at: now(),
          meta: { ...data, roomId: rid, restricted: false },
        });
      }
      out.push({
        rid,
        name: String(data.name || ""),
        privacy: String(data.privacy || ""),
        occupancy: intOr(data.occupancy, 0),
      });
    }
    return out;
  }

  async catvuRooms(nick) {
    const clean = safeNick(nick);
    if (!clean) return [];
    const cached = this.catvuCache.get(clean);
    if (cached && now() - cached.at < 60_000) return cached.rooms;
    try {
      const response = await fetch(
        "https://catvu.live/api/private-room/find?username=" + encodeURIComponent(clean),
        {
          headers: { "User-Agent": this.ua, Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!response.ok) return [];
      const json = await response.json();
      const rooms = [];
      for (const room of json?.rooms || []) {
        const rid = String(room?.roomId || room?.room_id || "");
        if (/^\d+-\d+$/.test(rid)) rooms.push(rid);
      }
      this.catvuCache.set(clean, { at: now(), rooms });
      return rooms;
    } catch {
      return [];
    }
  }

  async findInLists(targetCid, listIds = ["friends", "recent", "explore"], options = {}) {
    const {
      deadlineMs = 0,
      stopOnFirst = false,
      concurrency = 5,
      onRoom = null,
      onHit = null,
      ttl = 2_000,
    } = options;
    const target = String(targetCid || "");
    const hits = [];
    const seen = new Set();
    const roomIds = [];
    for (const listId of listIds) {
      const rids = await this.roomListRooms(listId);
      for (const rid of rids) {
        if (seen.has(rid)) continue;
        seen.add(rid);
        roomIds.push(rid);
      }
      if (deadlineMs && now() > deadlineMs) break;
    }

    let index = 0;
    let found = false;
    const workers = Array.from({ length: Math.min(concurrency, roomIds.length || 1) }, async () => {
      while (true) {
        if (found && stopOnFirst) return;
        if (deadlineMs && now() > deadlineMs) return;
        const i = index++;
        if (i >= roomIds.length) return;
        const rid = roomIds[i];
        try {
          onRoom?.(rid);
          const people = await this.roster(rid, ttl);
          if (people.some((person) => person.cid === target)) {
            const hit = { rid, people };
            hits.push(hit);
            onHit?.(rid, people);
            if (stopOnFirst) {
              found = true;
              return;
            }
          }
        } catch {
          /* segue para a proxima sala */
        }
      }
    });
    await Promise.all(workers);
    return hits;
  }

  async findInOwnRooms(targetCid, maxn = 60, options = {}) {
    const { deadlineMs = 0, concurrency = 6, onProgress = null } = options;
    const target = String(targetCid || "");
    const hits = [];
    let index = 1;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, maxn)) }, async () => {
      while (true) {
        if (deadlineMs && now() > deadlineMs) return;
        const n = index++;
        if (n > maxn) return;
        const rid = `${target}-${n}`;
        try {
          const meta = await this.roomMeta(rid);
          if (!meta || meta.restricted) continue;
          if (intOr(meta.occupancy, 0) <= 0) continue;
          const people = await this.roster(rid, 2_000);
          if (people.some((person) => person.cid === target)) {
            hits.push({ rid, people });
            onProgress?.(`achei ${target} em ${rid}`);
            return;
          }
        } catch {
          /* segue */
        }
      }
    });
    await Promise.all(workers);
    return hits;
  }

  async enterRoom(rid) {
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return { status: 0, text: "roomId invalido" };
    return this.raw(`/chat/chat-${id}/participants`, {
      method: "POST",
      body: { id: `${API}/user/user-${this.cid}` },
      withSauce: true,
    });
  }

  async leaveRoom(rid) {
    const id = String(rid || "");
    if (!/^\d+-\d+$/.test(id)) return { status: 0, text: "roomId invalido" };
    return this.raw(`/chat/chat-${id}/participants/user-${this.cid}`, {
      method: "DELETE",
      withSauce: true,
    });
  }

  async fetchImage(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      return { error: "url invalida", status: 400 };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { error: "protocolo invalido", status: 400 };
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "imvu.com" && !host.endsWith(".imvu.com")) {
      return { error: "host nao permitido", status: 400 };
    }

    const key = parsed.toString();
    const cached = this.imageCache.get(key);
    if (cached && now() - cached.at < IMAGE_TTL) {
      return { buffer: cached.buffer, contentType: cached.contentType, status: 200, cached: true };
    }

    if (!this.loggedIn) {
      const ok = await this.ensureLogin();
      if (!ok) return { error: this.lastError || "login falhou", status: 503 };
    }

    const headers = {
      "User-Agent": this.ua,
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      Origin: "https://www.imvu.com",
      Referer: "https://www.imvu.com/",
    };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    try {
      const response = await fetch(key, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return { error: `upstream ${response.status}`, status: 502 };
      const length = intOr(response.headers.get("content-length"), 0);
      if (length > IMAGE_MAX_BYTES) return { error: "imagem grande demais", status: 502 };
      let buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > IMAGE_MAX_BYTES) return { error: "imagem grande demais", status: 502 };
      let contentType = response.headers.get("content-type") || "image/png";

      // Alguns avatares devolvem um PNG minusculo/vazio no crop "dressup_front_heads".
      // Nesse caso cai para o avatar_image completo (mesma URL sem query string).
      if (contentType.includes("png") && buffer.length < 1_500 && parsed.search && parsed.pathname.includes("/image_avatar/")) {
        try {
          const fallbackUrl = new URL(parsed.toString());
          fallbackUrl.search = "";
          const fallback = await fetch(fallbackUrl.toString(), {
            headers,
            redirect: "follow",
            signal: AbortSignal.timeout(20_000),
          });
          if (fallback.ok) {
            const alt = Buffer.from(await fallback.arrayBuffer());
            if (alt.length > buffer.length && alt.length <= IMAGE_MAX_BYTES) {
              buffer = alt;
              contentType = fallback.headers.get("content-type") || contentType;
            }
          }
        } catch {
          /* mantem o original */
        }
      }

      this.imageCache.set(key, { at: now(), buffer, contentType });
      if (this.imageCache.size > IMAGE_CACHE_MAX) {
        const oldest = this.imageCache.keys().next().value;
        if (oldest) this.imageCache.delete(oldest);
      }
      return { buffer, contentType, status: 200 };
    } catch (error) {
      return { error: error?.message || String(error), status: 502 };
    }
  }

  invalidateRoom(rid) {
    this.roomMetaCache.delete(String(rid || ""));
    this.rosterCache.delete(String(rid || ""));
  }
}

export { delay };
