import crypto from "node:crypto";
import { EventEmitter } from "node:events";
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

  endListeners(room) {
    for (const res of room.listeners) {
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignora */
      }
    }
    room.listeners.clear();
  }

  async pump(room) {
    if (room.playing || room.listeners.size === 0) return;
    const song = room.queue.shift();
    if (!song) {
      this.endListeners(room);
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
        this.endListeners(room);
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
        this.endListeners(room);
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

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
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

  shutdown() {
    for (const room of this.rooms.values()) {
      room.queue = [];
      room.generation += 1;
      this.stopOutput(room);
      this.endListeners(room);
    }
    this.rooms.clear();
  }
}

export const radioStream = new RadioStream();
