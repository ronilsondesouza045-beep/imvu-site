import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { openMp3Stream } from "./songResolver.js";

const clean = (value) => String(value ?? "").trim();
const MAX_QUEUE = 30;
const MAX_LISTENER_BUFFER = 2 * 1024 * 1024;

const SECRET = clean(process.env.RADIO_SECRET) || crypto.randomBytes(32).toString("hex");
const PUBLIC_BASE = (
  clean(process.env.PUBLIC_BASE_URL) ||
  clean(process.env.RENDER_EXTERNAL_URL) ||
  `http://localhost:${Number(process.env.PORT) || 8080}`
).replace(/\/+$/, "");

// Silêncio MP3 de 1s, gerado pelo ffmpeg-static. É escrito em loop no
// /radio.mp3 quando não há música tocando, para o IMVU não derrubar a conexão.
let silenceMp3Promise = null;
function getSilenceMp3() {
  if (silenceMp3Promise) return silenceMp3Promise;
  silenceMp3Promise = new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawn(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=44100:cl=stereo",
          "-t",
          "1",
          "-q:a",
          "9",
          "-acodec",
          "libmp3lame",
          "-f",
          "mp3",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignora */
      }
      resolve(null);
    }, 8000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(chunks.length ? Buffer.concat(chunks) : null);
    });
  });
  return silenceMp3Promise;
}

const publicSong = (song) =>
  song
    ? {
        title: song.title,
        url: song.url,
        durationSec: song.durationSec || 0,
        thumbnail: song.thumbnail || "",
      }
    : null;

/**
 * One continuous MP3 stream per room. The IMVU media_player receives a stable
 * /api/radio/<room>/<token>.mp3 URL; the queue decides what is written into it.
 */
class RadioStream extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map();
    // Always have a listener so a stream error can never crash the process.
    this.on("streamError", () => {});
  }

  getRoom(roomId) {
    const id = clean(roomId);
    let room = this.rooms.get(id);
    if (!room) {
      room = {
        id,
        queue: [],
        current: null,
        playing: false,
        output: null,
        listeners: new Set(),
        generation: 0,
        startedAt: 0,
        error: "",
      };
      this.rooms.set(id, room);
    }
    return room;
  }

  tokenFor(roomId) {
    return crypto.createHmac("sha256", SECRET).update(clean(roomId)).digest("hex").slice(0, 32);
  }

  urlForRoom(roomId, session = "") {
    const id = clean(roomId);
    const nonce = clean(session);
    const query = nonce ? `?s=${encodeURIComponent(nonce)}` : "";
    return `${PUBLIC_BASE}/api/radio/${encodeURIComponent(id)}/${this.tokenFor(id)}.mp3${query}`;
  }

  /** Link público único do stream (o que o usuário cola no rádio do IMVU). */
  publicUrl() {
    return `${PUBLIC_BASE}/radio.mp3`;
  }

  verifyToken(roomId, token) {
    const expected = Buffer.from(this.tokenFor(roomId));
    const received = Buffer.from(clean(token));
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  enqueue(roomId, song) {
    const room = this.getRoom(roomId);
    if (!song?.url) throw new Error("Música inválida.");
    if (room.queue.length >= MAX_QUEUE) {
      throw new Error(`A fila está cheia (${MAX_QUEUE} músicas).`);
    }
    room.queue.push(song);
    if (room.listeners.size > 0 && !room.playing) {
      void this.pump(room);
    }
    return this.snapshot(room.id);
  }

  queueLength(roomId) {
    return this.getRoom(roomId).queue.length;
  }

  currentSong(roomId) {
    return publicSong(this.getRoom(roomId).current);
  }

  isPlaying(roomId) {
    return Boolean(this.getRoom(roomId).playing);
  }

  snapshot(roomId) {
    const room = this.getRoom(roomId);
    return {
      queue: room.queue.slice(0, MAX_QUEUE).map(publicSong),
      current: publicSong(room.current),
      playing: room.playing,
      listeners: room.listeners.size,
      startedAt: room.startedAt,
      error: room.error,
    };
  }

  skip(roomId) {
    const room = this.getRoom(roomId);
    const previous = room.current;
    let next = null;

    if (room.current) {
      room.current = null;
      room.generation += 1;
      this.stopOutput(room);
      next = room.queue[0] || null;
    } else if (room.queue.length > 0) {
      room.queue.shift();
      next = room.queue[0] || null;
    }

    room.playing = false;
    room.error = "";
    if (room.listeners.size > 0 && room.queue.length > 0) {
      void this.pump(room);
    } else if (room.listeners.size > 0) {
      this.endListeners(room);
      this.emit("idle", room.id);
    }

    return { previous: publicSong(previous), next: publicSong(next) };
  }

  stop(roomId) {
    const room = this.getRoom(roomId);
    room.queue = [];
    room.current = null;
    room.playing = false;
    room.error = "";
    room.generation += 1;
    this.stopOutput(room);
    this.endListeners(room);
    return this.snapshot(room.id);
  }

  stopOutput(room) {
    const output = room.output;
    room.output = null;
    if (output) {
      try {
        output.kill();
      } catch {
        /* ignora */
      }
    }
  }

  hasPublicListeners(room) {
    for (const res of room.listeners) {
      if (res.__publicRadio) return true;
    }
    return false;
  }

  endListeners(room) {
    for (const res of [...room.listeners]) {
      if (res.__publicRadio) continue;
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignora */
      }
      room.listeners.delete(res);
    }
  }

  async pump(room) {
    if (room.playing || room.listeners.size === 0) return;
    const song = room.queue.shift();
    if (!song) {
      if (!this.hasPublicListeners(room)) this.endListeners(room);
      this.emit("idle", room.id);
      return;
    }

    const generation = ++room.generation;
    room.current = song;
    room.playing = true;
    room.error = "";
    room.startedAt = Date.now();
    this.emit("track", room.id, publicSong(song));

    let output;
    try {
      output = await openMp3Stream(song);
    } catch (error) {
      if (generation !== room.generation) return;
      room.current = null;
      room.playing = false;
      room.error = error?.message || String(error);
      this.emit("streamError", room.id, room.error);
      if (room.listeners.size > 0 && room.queue.length > 0) {
        void this.pump(room);
      } else {
        if (!this.hasPublicListeners(room)) this.endListeners(room);
        this.emit("idle", room.id);
      }
      return;
    }

    if (generation !== room.generation) {
      output.kill();
      return;
    }

    room.output = output;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      if (generation !== room.generation) return;

      room.output = null;
      room.playing = false;
      room.current = null;
      if (error) {
        room.error = error?.message || String(error);
        this.emit("streamError", room.id, room.error);
      }

      if (room.listeners.size > 0 && room.queue.length > 0) {
        void this.pump(room);
      } else if (room.listeners.size > 0) {
        if (!this.hasPublicListeners(room)) this.endListeners(room);
        this.emit("idle", room.id);
      }
    };

    output.stream.on("data", (chunk) => {
      for (const res of room.listeners) {
        if (res.destroyed || res.writableEnded) {
          room.listeners.delete(res);
          continue;
        }
        if (res.writableLength > MAX_LISTENER_BUFFER) {
          try {
            res.destroy();
          } catch {
            /* ignora */
          }
          room.listeners.delete(res);
          continue;
        }
        try {
          res.write(chunk);
        } catch {
          room.listeners.delete(res);
        }
      }
    });
    output.stream.on("end", () => finish());
    output.stream.on("close", () => finish());
    output.stream.on("error", (error) => finish(error));
  }

  handleRequest(req, res, roomId, file) {
    const id = clean(roomId);
    const name = clean(file);

    if (!/^\d+-\d+$/.test(id)) {
      res.statusCode = 400;
      res.end("invalid room");
      return;
    }
    if (!name.endsWith(".mp3")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (!this.verifyToken(id, name.slice(0, -4))) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }

    const room = this.rooms.get(id);
    if (!room || (!room.current && room.queue.length === 0)) {
      res.statusCode = 404;
      res.end("off air");
      return;
    }

    this.serve(room, res);
  }

  serve(room, res) {
    res.setTimeout?.(0);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    room.listeners.add(res);
    const cleanup = () => room.listeners.delete(res);
    res.on("close", cleanup);
    res.on("error", cleanup);

    if (!room.playing) void this.pump(room);
  }

  /**
   * /radio.mp3: stream público contínuo. Se não houver música, escreve um
   * silêncio MP3 em loop; quando o bot toca, os chunks da música entram no
   * mesmo response.
   */
  servePublic(room, res) {
    res.setTimeout?.(0);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Transfer-Encoding": "chunked",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    res.__publicRadio = true;
    room.listeners.add(res);
    let silenceTimer = null;
    let closed = false;

    const cleanup = () => {
      closed = true;
      if (silenceTimer) clearInterval(silenceTimer);
      silenceTimer = null;
      room.listeners.delete(res);
    };

    const writeSilence = async () => {
      if (closed || res.destroyed || res.writableEnded) return;
      if (room.playing) return;
      if (res.writableLength > MAX_LISTENER_BUFFER) return;
      const buffer = await getSilenceMp3();
      if (!buffer || closed || res.destroyed || res.writableEnded || room.playing) return;
      try {
        res.write(buffer);
      } catch {
        cleanup();
      }
    };

    silenceTimer = setInterval(() => {
      void writeSilence();
    }, 1000);
    res.__silenceTimer = silenceTimer;
    res.on("close", cleanup);
    res.on("error", cleanup);
    void writeSilence();
  }

  handlePublicRequest(req, res, roomId) {
    res.setTimeout?.(0);
    const id = /^\d+-\d+$/.test(clean(roomId)) ? clean(roomId) : "__public__";
    const room = this.getRoom(id);
    this.servePublic(room, res);
    if (!room.playing) void this.pump(room);
  }

  shutdown() {
    for (const room of this.rooms.values()) {
      room.queue = [];
      room.generation += 1;
      this.stopOutput(room);
      for (const res of [...room.listeners]) {
        if (res.__silenceTimer) clearInterval(res.__silenceTimer);
        try {
          res.destroy?.();
        } catch {
          /* ignora */
        }
      }
      room.listeners.clear();
    }
    this.rooms.clear();
  }
}

export const radioStream = new RadioStream();
