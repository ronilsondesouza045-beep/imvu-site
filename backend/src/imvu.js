import { setTimeout as delay } from "node:timers/promises";

export const API = "https://api.imvu.com";
export const ASSET_BASE = "https://asset-server-akm.imvu.com";
export const WS_URL = "wss://wss-imq.imvu.com/streaming/imvu_pre";
export const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ROOM_META_TTL = 15_000;
const ROSTER_TTL = 6_000;
const ROOM_LIST_TTL = 20_000;
// Lista de candidatas publicas (recent/explore/feature/friends) por 2 min.
const PUBLIC_ROOMS_TTL = 120_000;
// Diretorio de salas classicas de chat (paginado de 25 em 25) por 2 min.
const CHAT_DIRECTORY_TTL = 120_000;
const USER_TTL = 10 * 60_000;
const IMAGE_TTL = 10 * 60_000;
const IMAGE_CACHE_MAX = 250;

const now = () => Date.now();

function normalizeUrl(value) {
  const s = String(value || "");
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

function absoluteAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return "https:" + raw;
  if (raw.startsWith("/")) return ASSET_BASE + raw;
  return raw;
}

/** Converte o scene JSON do IMVU em descritores de mesh+materiais. */
function meshSceneModel(scene) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const meshGroups = [];
  for (const object of objects) {
    for (const group of object?.meshGroups || []) {
      if (!group?.url) continue;
      const materials = [];
      for (const [slot, name] of Object.entries(group.materials || {})) {
        const def = object.materials?.[name] || {};
        const stage = def.stages?.[0] || {};
        const diffuse = stage.diffuse || {};
        materials.push({
          slot: intOr(slot, 0),
          name: String(name || ""),
          textureUrl: absoluteAssetUrl(diffuse.texture || ""),
          color: Array.isArray(diffuse.color) ? diffuse.color.slice(0, 3) : [1, 1, 1],
          twoSided: Boolean(def.twoSided),
          blending: Boolean(def.enableBlending),
          alphaTest: def.alphaTest?.enabled ? Number(def.alphaTest.value) || 0 : 0,
          selfIlluminated: Boolean(def.selfIlluminated),
        });
      }
      meshGroups.push({
        meshUrl: absoluteAssetUrl(group.url),
        materials,
        meshGroup: intOr(group.meshGroup, 0),
      });
    }
  }
  return {
    meshGroups,
    ambientColor: Array.isArray(scene?.ambientColor) ? scene.ambientColor : null,
    fog: scene?.fog || null,
  };
}

// Skeleton do shell: a câmera real do IMVU é um bone (camera.01.01.root),
// com alvo em camera.01.01.root.Target. A pose relativa é a mesma usada pelo client.
function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

function boneWorldTransform(bones, index, cache) {
  if (cache.has(index)) return cache.get(index);
  const bone = bones[index] || {};
  const relative = bone.relativeTransform || {};
  const rotation = Array.isArray(relative.rotation) ? relative.rotation : [0, 0, 0, 1];
  const position = Array.isArray(relative.translation) ? relative.translation : [0, 0, 0];
  const parentIndex = Number.isInteger(bone.parentIndex) ? bone.parentIndex : -1;
  let world = { rotation, position };
  if (parentIndex >= 0 && parentIndex < bones.length && parentIndex !== index) {
    const parent = boneWorldTransform(bones, parentIndex, cache);
    const rotated = quatRotate(parent.rotation, position);
    world = {
      rotation: quatMultiply(parent.rotation, rotation),
      position: [
        parent.position[0] + rotated[0],
        parent.position[1] + rotated[1],
        parent.position[2] + rotated[2],
      ],
    };
  }
  cache.set(index, world);
  return world;
}

function roomIdFromUrl(value) {
  const m = /room-(\d+-\d+)\s*$/.exec(String(value || ""));
  return m ? m[1] : "";
}

/**
 * Itens de uma resposta de room_list. Quando a URL tem query
 * (?room_type=chat&start_index=...), o no da lista vem com a chave igual ao
 * `id` do envelope, nao terminando em "/rooms" e/ou ela pode vir em qualquer
 * outro no com data.items. Por isso procuramos o primeiro no com items.
 */
function roomListItems(env) {
  const den = env?.denormalized;
  if (!den) return [];
  if (env.id && Array.isArray(den[env.id]?.data?.items)) return den[env.id].data.items;
  for (const node of Object.values(den)) {
    if (Array.isArray(node?.data?.items)) return node.data.items;
  }
  return [];
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
    this.lastStatus = 0;
    this.loginPromise = null;

    this.userCache = new Map();
    this.userNodeCache = new Map();
    this.profileCache = new Map();
    this.room3dCache = new Map();
    this.assetSceneCache = new Map();
    this.friendCidsCache = { at: 0, cids: new Set() };
    this.roomMetaCache = new Map();
    this.rosterCache = new Map();
    this.roomListCache = new Map();
    this.roomListEntriesCache = new Map();
    this.publicRoomsCache = { at: 0, rooms: [], requested: 0 };
    this.chatDirectoryCache = { at: 0, rooms: [], requested: 0 };
    this.chatDirectoryPromise = null;
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
      this.lastStatus = response.status;
      return { status: response.status, text: await response.text() };
    } catch (error) {
      this.lastStatus = 0;
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
    const wanted = clean.toLowerCase();
    let fallback = null;
    for (const [key, node] of Object.entries(den)) {
      if (!key.includes("/user/user-")) continue;
      const cid = cidFromUserUrl(key);
      if (!cid) continue;
      const person = this.personFromData(cid, node?.data);
      this.userCache.set(cid, { at: now(), person });
      // A busca do IMVU e fuzzy: "irOni" pode devolver "Guest_Ironi".
      // Prioriza sempre o username exato (ignorando caixa).
      if (String(person.username || "").toLowerCase() === wanted) return person;
      if (!fallback) fallback = person;
    }
    if (fallback) {
      this.log.info(
        `[imvu] resolve("${clean}") sem match exato; usando ${fallback.username} (${fallback.cid})`
      );
    }
    return fallback;
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
   * Perfil completo para o modal do site: nick, cid, avatar grande, bio,
   * status, seguidores/seguindo exatos, membro desde, idade e flags de AP.
   * Aceita nick ou cid. Cache de 60s por cid.
   */
  async profile(input, ttl = 60_000) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    let cid = "";
    if (/^\d+$/.test(raw)) {
      cid = raw;
    } else {
      const person = await this.resolve(raw);
      if (!person) return null;
      cid = person.cid;
    }
    const cached = this.profileCache.get(cid);
    if (cached && now() - cached.at < ttl) return cached.profile;

    const node = await this.userNode(cid, 0);
    if (!node?.data) return null;
    const data = node.data;

    const profileUrl = String(node.relations?.profile || "");
    const [profileEnv, subsEnv, followingEnv] = await Promise.all([
      profileUrl
        ? this.getJson(profileUrl.replace(API, "")).catch(() => null)
        : Promise.resolve(null),
      this.getJson(`/profile/profile-user-${cid}/subscribers?limit=1`).catch(() => null),
      this.getJson(`/profile/profile-user-${cid}/subscriptions?limit=1`).catch(() => null),
    ]);

    let profileData = null;
    for (const [key, item] of Object.entries(profileEnv?.denormalized || {})) {
      if (!key.includes(`/profile/profile-user-${cid}`)) continue;
      if (!item?.data) continue;
      if (
        item.data.avatar_name !== undefined ||
        item.data.title !== undefined ||
        item.data.approx_follower_count !== undefined
      ) {
        profileData = item.data;
        break;
      }
    }

    const totalFrom = (env) => {
      for (const item of Object.values(env?.denormalized || {})) {
        if (item?.data && item.data.total_count !== undefined) {
          return intOr(item.data.total_count, 0);
        }
      }
      return null;
    };
    const followers = totalFrom(subsEnv) ?? intOr(profileData?.approx_follower_count, 0);
    const following = totalFrom(followingEnv) ?? intOr(profileData?.approx_following_count, 0);

    const username = String(data.username || profileData?.avatar_name || "");
    const displayName = String(data.display_name || profileData?.title || username || cid);
    const registered = intOr(data.registered, 0);
    const joinedAt = String(
      data.created || (registered ? new Date(registered * 1000).toISOString() : "")
    );
    const ageValue = Number(data.age);
    const age = Number.isFinite(ageValue) && ageValue > 0 ? Math.trunc(ageValue) : null;
    const encoded = encodeURIComponent(username || cid);

    const profile = {
      cid,
      username,
      displayName,
      nickname: username || displayName || cid,
      avatar: normalizeUrl(data.avatar_image || profileData?.image || data.thumbnail_url || ""),
      portrait: normalizeUrl(data.avatar_portrait_image || data.thumbnail_url || ""),
      thumbnail: normalizeUrl(data.thumbnail_url || profileData?.image || ""),
      bio: String(data.interests || "").trim(),
      status: String(data.tagline || data.availability || "").trim(),
      followers,
      following,
      joinedAt,
      registered,
      age,
      country: String(data.country || ""),
      gender: String(data.gender || ""),
      isAp: Boolean(data.is_ap),
      isApPlus: Boolean(data.is_ap_plus),
      isApFounder: Boolean(data.is_ap_plus_founder),
      isVip: Boolean(data.is_vip),
      isAgeVerified: Boolean(data.is_ageverified),
      isAdult: Boolean(data.is_adult),
      online: Boolean(data.online),
      webUrl: `https://www.imvu.com/next/u/${encoded}/`,
      appUrl: `https://www.imvu.com/user/${encoded}/`,
    };
    this.profileCache.set(cid, { at: now(), profile });
    if (this.profileCache.size > 300) {
      const oldest = this.profileCache.keys().next().value;
      if (oldest) this.profileCache.delete(oldest);
    }
    return profile;
  }

  /** Extrai a câmera real do shell a partir do skeleton JSON do IMVU. */
  async shellCamera(scene) {
    const object = scene?.objects?.[0] || {};
    const cameraDef = Array.isArray(object.cameras) ? object.cameras[0] : null;
    const skeletonUrl = absoluteAssetUrl(object?.skeleton?.url || "");
    if (!cameraDef?.bone || !skeletonUrl) return null;
    const skeleton = await this.fetchAssetJson(skeletonUrl).catch(() => null);
    const bones = Array.isArray(skeleton?.bones) ? skeleton.bones : [];
    if (!bones.length) return null;
    const cameraIndex = bones.findIndex((bone) => bone?.name === cameraDef.bone);
    if (cameraIndex < 0) return null;
    const targetIndex = bones.findIndex(
      (bone) => bone?.name === `${cameraDef.bone}.Target`
    );
    const cache = new Map();
    const camera = boneWorldTransform(bones, cameraIndex, cache);
    const target = targetIndex >= 0 ? boneWorldTransform(bones, targetIndex, cache) : null;
    const seats = {};
    for (let i = 0; i < bones.length; i += 1) {
      const match = /^Seat0*(\d+)\./.exec(String(bones[i]?.name || ""));
      if (!match) continue;
      const seatNumber = Number(match[1]);
      if (!Number.isFinite(seatNumber) || seats[seatNumber]) continue;
      seats[seatNumber] = boneWorldTransform(bones, i, cache).position;
    }
    return {
      position: camera.position,
      target: target?.position || [
        camera.position[0],
        camera.position[1],
        camera.position[2] - 5,
      ],
      fov: Number(cameraDef.fovY) || 45,
      near: Number(cameraDef.nearZ) || 0.3,
      far: Number(cameraDef.farZ) || 1000,
      seats,
    };
  }

  /** Baixa e cacheia um scene JSON de asset do IMVU (room/furniture). */
  async fetchAssetJson(url, ttl = 10 * 60_000) {
    const key = String(url || "");
    if (!key) return null;
    const cached = this.assetSceneCache.get(key);
    if (cached && now() - cached.at < ttl) return cached.json;
    const headers = { "User-Agent": this.ua, Accept: "application/json" };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    try {
      const response = await fetch(key, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const json = await response.json();
      this.assetSceneCache.set(key, { at: now(), json });
      if (this.assetSceneCache.size > 300) {
        const oldest = this.assetSceneCache.keys().next().value;
        if (oldest) this.assetSceneCache.delete(oldest);
      }
      return json;
    } catch {
      return null;
    }
  }

  /**
   * Dados experimentais para o Modo Cinema 3D: shell/scene da sala, lista de
   * moveis com posicao/rotacao/scale, imagens dos produtos, meshGroups reais
   * (mesh JSON + texturas) e roster. O frontend monta BufferGeometry com os
   * meshes reais e usa caixa cinza apenas quando o modelo falha.
   */
  async room3d(roomId, ttl = 60_000) {
    const id = String(roomId || "");
    if (!/^\d+-\d+$/.test(id)) return null;
    const cached = this.room3dCache.get(id);
    if (cached && now() - cached.at < ttl) return cached.data;

    const roomEnv = await this.getJson(`/room/room-${id}`).catch(() => null);
    const roomDen = roomEnv?.denormalized || {};
    let roomNode = null;
    for (const [key, node] of Object.entries(roomDen)) {
      if (key.endsWith(`/room/room-${id}`) && node?.data) {
        roomNode = node;
        break;
      }
    }
    if (!roomNode) return null;
    const relations = roomNode.relations || {};

    const sceneUrl = String(relations.scene || "");
    const shellUrl = String(relations.shell_product || "");
    const [sceneEnv, shellEnv] = await Promise.all([
      sceneUrl ? this.getJson(sceneUrl.replace(API, "")).catch(() => null) : Promise.resolve(null),
      shellUrl ? this.getJson(shellUrl.replace(API, "")).catch(() => null) : Promise.resolve(null),
    ]);

    const firstWithData = (env, predicate) => {
      for (const node of Object.values(env?.denormalized || {})) {
        if (node?.data && (!predicate || predicate(node.data))) return node;
      }
      return null;
    };
    const sceneNode = firstWithData(
      sceneEnv,
      (data) =>
        data.room_asset_url !== undefined ||
        data.scene_asset_url !== undefined ||
        data.preview_image !== undefined
    );
    const shellNode = firstWithData(
      shellEnv,
      (data) => data.product_id !== undefined || data.product_name !== undefined
    );
    const sceneData = sceneNode?.data || {};
    const shellData = shellNode?.data || {};

    const furnitureUrl = String(
      sceneNode?.relations?.furniture || (sceneUrl ? `${sceneUrl}/furniture` : "")
    );
    const furnitureEnv = furnitureUrl
      ? await this.getJson(furnitureUrl.replace(API, "")).catch(() => null)
      : null;
    const furnitureDen = furnitureEnv?.denormalized || {};
    const itemUrls = roomListItems(furnitureEnv);

    const furniture = [];
    const productIds = new Set();
    for (const itemUrl of itemUrls) {
      const wrapper = furnitureDen[itemUrl];
      if (!wrapper) continue;
      const ref = String(wrapper.relations?.ref || itemUrl);
      const data = furnitureDen[ref]?.data || wrapper.data || {};
      const productId = String(data.product_id || "");
      if (!productId) continue;
      furniture.push({
        instanceId: intOr(data.instance_id, 0),
        node: String(data.node || ""),
        productId,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        z: Number(data.z) || 0,
        yaw: Number(data.yaw) || 0,
        pitch: Number(data.pitch) || 0,
        roll: Number(data.roll) || 0,
        scale: Number(data.scale) || 1,
        assetUrl: normalizeUrl(data.asset_url || ""),
      });
      productIds.add(productId);
      if (furniture.length >= 80) break;
    }

    // Metadados dos produtos (nome/imagem) para as caixas do 3D.
    const products = new Map();
    const ids = [...productIds].slice(0, 40);
    let productIndex = 0;
    const productWorkers = Array.from({ length: Math.min(5, ids.length || 1) }, async () => {
      while (true) {
        const i = productIndex++;
        if (i >= ids.length) return;
        const pid = ids[i];
        const env = await this.getJson(`/product/product-${pid}`).catch(() => null);
        const node = firstWithData(
          env,
          (data) => data.product_name !== undefined || data.product_image !== undefined
        );
        if (node?.data) products.set(pid, node.data);
      }
    });
    await Promise.all(productWorkers);

    // Cena real do shell (sala) + cenas dos moveis -> meshGroups/texturas.
    const shellSceneUrl = normalizeUrl(shellData.asset_url || sceneData.room_asset_url || "");
    const shellScene = shellSceneUrl ? await this.fetchAssetJson(shellSceneUrl).catch(() => null) : null;
    const shellModel = shellScene ? meshSceneModel(shellScene) : null;
    const shellCamera = shellScene ? await this.shellCamera(shellScene).catch(() => null) : null;

    const assetUrls = [
      ...new Set(furniture.map((item) => normalizeUrl(item.assetUrl)).filter(Boolean)),
    ].slice(0, 40);
    const assetModels = new Map();
    let assetIndex = 0;
    const assetWorkers = Array.from({ length: Math.min(5, assetUrls.length || 1) }, async () => {
      while (true) {
        const i = assetIndex++;
        if (i >= assetUrls.length) return;
        const url = assetUrls[i];
        const sceneJson = await this.fetchAssetJson(url).catch(() => null);
        if (sceneJson) assetModels.set(url, meshSceneModel(sceneJson));
      }
    });
    await Promise.all(assetWorkers);

    const assets = furniture.map((item) => {
      const product = products.get(item.productId) || {};
      const assetUrl = normalizeUrl(product.asset_url || item.assetUrl || "");
      const modelUrl = /\.(glb|gltf|obj)(\?|$)/i.test(assetUrl) ? assetUrl : "";
      return {
        id: item.instanceId || `${item.productId}-${item.node}`,
        instanceId: item.instanceId,
        node: item.node,
        productId: item.productId,
        name: String(product.product_name || `Móvel ${item.productId}`),
        image: normalizeUrl(product.product_image || ""),
        assetUrl,
        modelUrl,
        model: assetModels.get(normalizeUrl(item.assetUrl)) || null,
        type: modelUrl ? (modelUrl.toLowerCase().includes(".obj") ? "obj" : "gltf") : "mesh",
        position: [item.x, item.y, item.z],
        rotation: [item.pitch, item.yaw, item.roll],
        scale: item.scale,
      };
    });

    const xs = furniture.map((item) => item.x);
    const zs = furniture.map((item) => item.z);
    const bounds = {
      minX: xs.length ? Math.min(...xs) : -10,
      maxX: xs.length ? Math.max(...xs) : 10,
      minZ: zs.length ? Math.min(...zs) : -10,
      maxZ: zs.length ? Math.max(...zs) : 10,
    };

    const people = await this.roster(id, 0).catch(() => []);
    const occupants = people
      .filter((person) => person?.cid && String(person.cid) !== String(this.cid))
      .map((person) => ({
        cid: person.cid,
        username: person.username,
        displayName: person.displayName,
        avatar: person.avatar || "",
        portrait: person.avatarPortrait || person.portrait || "",
        lookThumbnail: person.lookThumbnail || "",
        lookImage: person.lookImage || "",
        seatNumber: person.seatNumber || 0,
        isVip: Boolean(person.isVip),
        isAp: Boolean(person.isAp),
        online: Boolean(person.online),
      }));

    const renderedImage = normalizeUrl(
      roomNode.data.rendered_image || sceneData.preview_image || roomNode.data.image_url || ""
    );
    const data = {
      roomId: id,
      name: String(roomNode.data.name || `Sala ${id}`),
      renderedImage,
      previewImage: normalizeUrl(sceneData.preview_image || renderedImage),
      shell: {
        productId: String(shellData.product_id || ""),
        name: String(shellData.product_name || ""),
        image: normalizeUrl(shellData.product_image || ""),
        assetUrl: shellSceneUrl,
        sceneUrl: normalizeUrl(shellData.scene_url || ""),
        model: shellModel,
        camera: shellCamera,
      },
      scene: {
        roomAssetUrl: normalizeUrl(sceneData.room_asset_url || ""),
        sceneAssetUrl: normalizeUrl(sceneData.scene_asset_url || ""),
        previewImage: normalizeUrl(sceneData.preview_image || ""),
      },
      environment: {
        ambientColor: shellModel?.ambientColor || null,
        fog: shellModel?.fog || null,
      },
      assets,
      occupants,
      bounds,
      counts: { furniture: furniture.length, products: products.size, models: assetModels.size },
      warning: furniture.length ? "" : "A sala não expôs móveis para o 3D.",
    };

    this.room3dCache.set(id, { at: now(), data });
    if (this.room3dCache.size > 50) {
      const oldest = this.room3dCache.keys().next().value;
      if (oldest) this.room3dCache.delete(oldest);
    }
    return data;
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
    const match = /room-(\d+-\d+)/i.exec(url) || /(\d+-\d+)(?:[/?#].*)?$/.exec(url);
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
    const privateHint =
      restricted || hintPrivate || String(m.privacy || "").toLowerCase() === "private";
    let name = String(m.name || "") || hintName;
    if (!name) {
      // Sala privada de terceiro: o room node vem 403 e nao entrega o nome.
      // Mostra o ID completo para o link e o painel continuarem uteis.
      name = privateHint ? `Sala privada (ID: ${id})` : id;
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

    const isPrivate = privateHint;
    // Sem nome real, o link direto e montado pelo roomId (exigencia do radar
    // para sala privada de terceiro). Com nome, usa o formato do cliente IMVU.
    const hasRealName =
      Boolean(name) &&
      name !== id &&
      !/^Sala privada \(ID:/i.test(name) &&
      !/^Sala \d+-\d+$/.test(name);
    const directLink = owner && hasRealName
      ? `imvu://room/${encodeQuery(owner)}/${encodeQuery(name)}`
      : id
        ? `imvu://room/${id}`
        : "";
    const webLink = id ? `https://www.imvu.com/next/chat/room-${id}/` : "";

    return {
      roomId: id,
      name,
      privacy: isPrivate ? "private" : String(m.privacy || "public"),
      privacyLabel: isPrivate ? "Privada" : "Pública",
      room_type: String(m.room_type || m.roomType || m.type || ""),
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
        // Dados do participante no chat: look 2D dentro da sala e assento.
        const participant = itemNode?.data || {};
        person.lookImage = normalizeUrl(participant.look_image || participant.rendered_image || "");
        person.lookThumbnail = normalizeUrl(participant.look_thumbnail || "");
        person.seatNumber = intOr(participant.seat_number, 0);
        person.seatFurniId = intOr(participant.seat_furni_id, 0);
        this.userCache.set(cid, { at: now(), person });
        seen.add(cid);
        people.push(person);
      }
    }
    this.rosterCache.set(id, { at: now(), people });
    return people;
  }

  /** Converte o envelope de uma lista de salas em entradas normalizadas. */
  roomEntriesFromResponse(env) {
    const den = env?.denormalized || {};
    const items = roomListItems(env);
    const entries = [];
    const seen = new Set();
    for (const item of items) {
      const itemNode = den[item] || {};
      const ref = itemNode?.relations?.ref || item;
      const rid = roomIdFromUrl(ref);
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      const data = den[ref]?.data || itemNode?.data || {};
      if (data.name) {
        this.roomMetaCache.set(rid, {
          at: now(),
          meta: { ...data, roomId: rid, restricted: false },
        });
      }
      entries.push({
        rid,
        name: String(data.name || ""),
        privacy: String(data.privacy || ""),
        occupancy: data.occupancy === null || data.occupancy === undefined ? null : intOr(data.occupancy, 0),
        capacity: intOr(data.capacity, 0),
        owner: String(data.owner_avatarname || ""),
        type: String(data.type || ""),
        image: normalizeUrl(data.image_url || ""),
        render: normalizeUrl(data.themed_image_url || data.image_url || ""),
      });
    }
    return entries;
  }

  /**
   * Entradas de uma lista oficial de salas (friends/recent/explore/feature)
   * com nome, privacidade e occupancy denormalizados pelo IMVU.
   */
  async roomListEntries(listId, ttl = ROOM_LIST_TTL) {
    if (!this.cid) return [];
    const key = String(listId || "");
    if (!/^[a-z_]+$/i.test(key)) return [];
    const cached = this.roomListEntriesCache.get(key);
    if (cached && now() - cached.at < ttl) return cached.entries;

    const env = await this.getJson(`/room_list/room_list-${this.cid}-${key}/rooms`);
    const entries = this.roomEntriesFromResponse(env);
    this.roomListEntriesCache.set(key, { at: now(), entries });
    return entries;
  }

  async roomListRooms(listId) {
    const entries = await this.roomListEntries(listId, ROOM_LIST_TTL);
    return entries.map((entry) => entry.rid);
  }

  /**
   * Diretorio de salas classicas de chat (room_type=chat), paginado de 25 em
   * 25 com start_index. Cache de 2min. E aqui que ficam as salas que nao
   * aparecem nas listas personalizadas (recent/explore/feature) do bot.
   */
  async chatRoomDirectory({ maxRooms = 1000, ttl = CHAT_DIRECTORY_TTL, concurrency = 4 } = {}) {
    if (!this.cid) return [];
    const cached = this.chatDirectoryCache;
    if (cached?.at && now() - cached.at < ttl && cached.requested >= maxRooms) {
      return cached.rooms.slice(0, maxRooms);
    }
    if (this.chatDirectoryPromise) return this.chatDirectoryPromise;

    const pageSize = 25;
    const totalPages = Math.max(1, Math.ceil(maxRooms / pageSize));
    const batchSize = Math.max(1, Math.min(6, concurrency));
    const rooms = new Map();

    this.chatDirectoryPromise = (async () => {
      for (let pageStart = 0; pageStart < totalPages; pageStart += batchSize) {
        const pages = [];
        for (let page = pageStart; page < Math.min(totalPages, pageStart + batchSize); page += 1) {
          pages.push(page);
        }
        let failed = 0;
        await Promise.all(
          pages.map(async (page) => {
            const start = page * pageSize;
            const env = await this.getJson(
              `/room_list/room_list-${this.cid}-explore/rooms?room_type=chat&start_index=${start}&limit=${pageSize}`
            ).catch(() => null);
            if (!env) {
              failed += 1;
              return;
            }
            for (const entry of this.roomEntriesFromResponse(env)) {
              if (!rooms.has(entry.rid)) rooms.set(entry.rid, entry);
            }
          })
        );
        if (failed === pages.length) break;
        if (pageStart + batchSize < totalPages) await delay(120);
      }
      const list = [...rooms.values()];
      this.chatDirectoryCache = { at: now(), rooms: list, requested: maxRooms };
      return list.slice(0, maxRooms);
    })()
      .catch(() => {
        const fallback = this.chatDirectoryCache?.rooms || [];
        return fallback.slice(0, maxRooms);
      })
      .finally(() => {
        this.chatDirectoryPromise = null;
      });

    return this.chatDirectoryPromise;
  }

  /**
   * Candidatas a sala publica: junta as listas personalizadas e o diretorio
   * de salas de chat, remove duplicatas/privadas e ordena pelas mais
   * movimentadas. Cache de 2min.
   */
  async publicRoomCandidates({ limit = 1000, ttl = PUBLIC_ROOMS_TTL } = {}) {
    if (!this.cid) return [];
    const cached = this.publicRoomsCache;
    if (cached?.at && now() - cached.at < ttl && cached.requested >= limit) {
      return cached.rooms.slice(0, limit);
    }
    const seen = new Map();
    for (const listId of ["recent", "explore", "feature", "friends"]) {
      const entries = await this.roomListEntries(listId, PUBLIC_ROOMS_TTL).catch(() => []);
      for (const entry of entries) {
        if (!entry?.rid || seen.has(entry.rid)) continue;
        if (String(entry.privacy || "").toLowerCase() === "private") continue;
        seen.set(entry.rid, entry);
      }
    }
    const directory = await this.chatRoomDirectory({ maxRooms: limit }).catch(() => []);
    for (const entry of directory) {
      if (!entry?.rid || seen.has(entry.rid)) continue;
      if (String(entry.privacy || "").toLowerCase() === "private") continue;
      seen.set(entry.rid, entry);
    }
    const rooms = [...seen.values()].sort(
      (a, b) => (Number(b.occupancy) || 0) - (Number(a.occupancy) || 0)
    );
    this.publicRoomsCache = { at: now(), rooms, requested: limit };
    return rooms.slice(0, limit);
  }

  /**
   * cids dos amigos da conta do bot. Usado para confiar na sala da lista
   * `friends` quando o roster da sala privada vem 403 e o alvo e o unico amigo.
   */
  async friendCids(ttl = 5 * 60_000) {
    if (!this.cid) return new Set();
    if (this.friendCidsCache && now() - this.friendCidsCache.at < ttl) {
      return this.friendCidsCache.cids;
    }
    const env = await this.getJson(`/user/user-${this.cid}/friends?limit=200`);
    const den = env?.denormalized;
    if (!den) return this.friendCidsCache.cids || new Set();
    const cids = new Set();
    for (const [key, node] of Object.entries(den)) {
      if (!node?.relations?.viewer_friend) continue;
      const cid = cidFromUserUrl(key);
      if (cid) cids.add(cid);
    }
    this.friendCidsCache = { at: now(), cids };
    return cids;
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
