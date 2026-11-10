/**
 * Cliente do indice publico catvu.live.
 *
 * O /api/private-room/find devolve a sala atual do nick mesmo quando ele
 * esta parado (inclusive sala privada), com roomId, nome, isPrivate e
 * hasOccupiedPrivateRoom.
 *
 * O /api/private-room/watch/<roomId> e um SSE com snapshot do roster e
 * eventos joined/left. E a fonte que preenche os ocupantes quando o roster
 * do IMVU vem 403 (sala privada de terceiro).
 */

const BASE = "https://catvu.live";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const FIND_TTL = 30_000;
const FIND_CACHE_MAX = 500;
const FIND_MIN_INTERVAL = 1_000;
const SNAPSHOT_TTL = 10_000;
const findCache = new Map();
const snapshotCache = new Map();
let findChain = Promise.resolve();
let lastFindAt = 0;

function preferJina() {
  return process.env.CATVU_MODE === "jina" || process.env.RENDER === "true";
}

function parseJinaJson(text) {
  const raw = String(text || "");
  const marker = "Markdown Content:";
  const index = raw.indexOf(marker);
  const body = index >= 0 ? raw.slice(index + marker.length) : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Jina sem JSON");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Busca JSON do catvu. No Render o catvu bloqueia o IP e estoura timeout;
 * nesse caso usa o Jina Reader, que acessa o catvu e devolve o JSON em texto.
 */
async function fetchCatvuJson(url, { timeout = 30_000 } = {}) {
  if (!preferJina()) {
    try {
      const direct = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(Math.min(timeout, 4_000)),
      });
      if (direct.ok) return await direct.json();
    } catch {
      /* cai para o Jina */
    }
  }

  const jinaUrl = `https://r.jina.ai/http://${String(url).replace(/^https?:\/\//, "")}`;
  const proxied = await fetch(jinaUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/plain",
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!proxied.ok) throw new Error(`jina HTTP ${proxied.status}`);
  return parseJinaJson(await proxied.text());
}

/** Serializa e espaça as consultas no catvu para reduzir 429. */
function scheduleFind(task) {
  const run = async () => {
    const wait = Math.max(0, FIND_MIN_INTERVAL - (Date.now() - lastFindAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastFindAt = Date.now();
    return task();
  };
  const result = findChain.then(run, run);
  findChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function normalizeRoom(room) {
  const roomId = String(room?.roomId || room?.room_id || "");
  if (!/^\d+-\d+$/.test(roomId)) return null;
  return {
    roomId,
    name: decodeHtmlEntities(room?.roomName || room?.room_name || room?.name || ""),
    isPrivate: Boolean(room?.isPrivate ?? room?.is_private),
    isVipOnly: Boolean(room?.isVipOnly ?? room?.is_vip_only),
    isApOnly: Boolean(room?.isApOnly ?? room?.is_ap_only),
    source: String(room?.source || ""),
  };
}

function normalizeProfile(profile, fallbackNick) {
  if (!profile) return null;
  return {
    cid: String(profile.cid || ""),
    username: String(profile.username || fallbackNick || ""),
    displayName: String(profile.displayName || profile.display_name || profile.username || fallbackNick || ""),
    avatar: String(profile.thumbnailUrl || profile.thumbnail_url || profile.avatar || ""),
    online: Boolean(profile.online),
  };
}

function cacheFind(key, data) {
  findCache.set(key, { at: Date.now(), data });
  if (findCache.size > FIND_CACHE_MAX) {
    const oldest = findCache.keys().next().value;
    if (oldest) findCache.delete(oldest);
  }
}

/**
 * nick -> { cid, online, rooms[], privateRoomCount, hasOccupiedPrivateRoom, hint }
 * Usa cache curto e devolve o ultimo resultado bom em caso de 429/timeout.
 */
export async function findRooms(nick, { timeout = 10_000, force = false } = {}) {
  const clean = String(nick || "").trim();
  if (!clean) return null;
  const key = clean.toLowerCase();
  const cached = findCache.get(key);
  if (!force && cached && Date.now() - cached.at < FIND_TTL) return cached.data;

  return scheduleFind(async () => {
    try {
      const json = await fetchCatvuJson(
        `${BASE}/api/private-room/find?username=${encodeURIComponent(clean)}`,
        { timeout }
      );
      if (process.env.CATVU_DEBUG) {
        console.error(`[catvu] find ${clean} ok rooms=${Array.isArray(json?.rooms) ? json.rooms.length : 0}`);
      }
      const rooms = (Array.isArray(json?.rooms) ? json.rooms : [])
        .map(normalizeRoom)
        .filter(Boolean);

      const data = {
        cid: String(json?.cid || json?.profile?.cid || ""),
        online: Boolean(json?.online || json?.profile?.online),
        profile: normalizeProfile(json?.profile, clean),
        rooms,
        privateRoomCount: Number(json?.privateRoomCount || 0),
        hasOccupiedPrivateRoom: Boolean(json?.hasOccupiedPrivateRoom),
        hint: String(json?.hint || ""),
        fetchedAt: Date.now(),
      };
      cacheFind(key, data);
      return data;
    } catch (error) {
      if (process.env.CATVU_DEBUG) {
        console.error(`[catvu] find ${clean} falhou:`, error?.message || error);
      }
      return cached ? cached.data : null;
    }
  });
}

/**
 * Snapshot unico da sala via /api/room/<id>?lite=1.
 * Devolve room + participants (cid, username, displayName).
 * E o bastante para o roster inicial; joined/left chegam depois pelo IMQ.
 */
export async function fetchRoomSnapshot(roomId, nick, { timeout = 30_000, force = false } = {}) {
  const id = String(roomId || "");
  if (!/^\d+-\d+$/.test(id)) return null;
  const cached = snapshotCache.get(id);
  if (!force && cached && Date.now() - cached.at < SNAPSHOT_TTL) return cached.data;

  const url =
    `${BASE}/api/room/${encodeURIComponent(id)}?lite=1&fresh=1&username=` +
    encodeURIComponent(String(nick || ""));

  return scheduleFind(async () => {
    try {
      const json = await fetchCatvuJson(url, { timeout });
      const participants = (Array.isArray(json?.participants) ? json.participants : [])
        .map((person) => ({
          cid: String(person?.cid || ""),
          username: String(person?.username || ""),
          displayName: String(person?.displayName || person?.display_name || person?.username || ""),
        }))
        .filter((person) => /^\d+$/.test(person.cid));

      const data = {
        room: {
          roomId: id,
          name: String(json?.room?.name || ""),
          isPrivate: Boolean(json?.room?.isPrivate),
          ownerUsername: String(json?.room?.ownerUsername || ""),
          occupancy: Number(json?.room?.occupancy || 0),
        },
        participants,
        fetchedAt: Date.now(),
      };
      snapshotCache.set(id, { at: Date.now(), data });
      if (process.env.CATVU_DEBUG) {
        console.error(`[catvu] snapshot ${id} ok participants=${participants.length}`);
      }
      return data;
    } catch (error) {
      if (process.env.CATVU_DEBUG) {
        console.error(`[catvu] snapshot ${id} falhou:`, error?.message || error);
      }
      return cached ? cached.data : null;
    }
  });
}

export function catvuPerson(raw) {
  const cid = String(raw?.cid || raw?.customers_id || raw?.id || "");
  if (!/^\d+$/.test(cid)) return null;
  const username = String(raw?.username || raw?.name || cid);
  const displayName = String(raw?.displayName || raw?.display_name || username || cid);
  const avatar = String(
    raw?.thumbnailUrl || raw?.thumbnail_url || raw?.avatar || raw?.portrait || raw?.avatar_image || ""
  );
  return {
    cid,
    username,
    displayName,
    avatar,
    render: "",
    portrait: "",
    isVip: Boolean(raw?.isVip ?? raw?.is_vip),
    isAp: Boolean(raw?.isAp ?? raw?.is_ap),
    online: true,
  };
}

/**
 * Abre o SSE de roster da sala.
 * handlers: { onSnapshot(participants, payload), onJoin(person, payload),
 *             onLeave(person, payload), onStatus(data), onError(error) }
 * Retorna { stop() }.
 */
export function watchRoom(
  roomId,
  { onSnapshot, onJoin, onLeave, onStatus, onError, log = console } = {}
) {
  const rid = String(roomId || "");
  let stopped = false;
  let controller = null;
  let attempt = 0;
  let watchdog = null;
  let lastDataAt = Date.now();

  const resetWatchdog = () => {
    lastDataAt = Date.now();
  };

  const loop = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        resetWatchdog();
        if (watchdog) clearInterval(watchdog);
        watchdog = setInterval(() => {
          if (Date.now() - lastDataAt > 90_000) {
            try {
              controller?.abort();
            } catch {
              /* ignora */
            }
          }
        }, 15_000);

        const response = await fetch(`${BASE}/api/private-room/watch/${encodeURIComponent(rid)}`, {
          headers: {
            "User-Agent": UA,
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`watch HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "message";
        let dataLines = [];

        const dispatch = () => {
          if (!dataLines.length) {
            eventName = "message";
            return;
          }
          const raw = dataLines.join("\n");
          dataLines = [];
          const currentEvent = eventName || "message";
          eventName = "message";
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            return;
          }
          const type = currentEvent || payload?.type || "message";
          if (type === "snapshot") {
            const participants = Array.isArray(payload?.data?.participants)
              ? payload.data.participants
              : [];
            onSnapshot?.(participants, payload);
          } else if (type === "joined") {
            const person = payload?.data?.person || payload?.data || {};
            onJoin?.(person, payload);
          } else if (type === "left") {
            const person = payload?.data?.person || payload?.data || {};
            onLeave?.(person, payload);
          } else if (type === "status") {
            onStatus?.(payload?.data || payload);
          } else if (type === "error") {
            onError?.(payload?.data || payload);
          }
        };

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          resetWatchdog();
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            let line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line === "") {
              dispatch();
              continue;
            }
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }

        attempt = 0;
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2_000));
      } catch (error) {
        if (stopped) break;
        attempt += 1;
        log.warn(`[catvu] watch ${rid} caiu: ${error?.message || error}`);
        onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2_000 * attempt)));
      } finally {
        if (watchdog) {
          clearInterval(watchdog);
          watchdog = null;
        }
        try {
          controller?.abort();
        } catch {
          /* ignora */
        }
      }
    }
  };

  void loop();

  return {
    stop() {
      stopped = true;
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
      try {
        controller?.abort();
      } catch {
        /* ignora */
      }
    },
  };
}
