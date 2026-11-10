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
const FIND_MIN_INTERVAL = 750;
const findCache = new Map();
let findChain = Promise.resolve();
let lastFindAt = 0;

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
      const response = await fetch(`${BASE}/api/private-room/find?username=${encodeURIComponent(clean)}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (process.env.CATVU_DEBUG) {
        console.error(`[catvu] find ${clean} -> HTTP ${response.status}`);
      }
      if (!response.ok) {
        if (cached) return cached.data;
        return null;
      }
      const json = await response.json();
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
