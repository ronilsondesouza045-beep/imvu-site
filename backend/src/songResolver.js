import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import play from "play-dl";
import ytdl from "ytdl-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YOUTUBE_URL = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i;
const SEARCH_TIMEOUT_MS = 25_000;
const YTDLP = path.join(
  __dirname,
  "..",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const YTDLP_READY = fs.existsSync(YTDLP);

const clean = (value) => String(value ?? "").trim();

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function youtubeId(url) {
  try {
    return play.extractID(url) || "";
  } catch {
    return "";
  }
}

function runYtDlpJson(args) {
  return new Promise((resolve, reject) => {
    if (!YTDLP_READY) {
      reject(new Error("binário do yt-dlp não instalado (rode npm install)."));
      return;
    }
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp terminou com código ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("yt-dlp retornou JSON inválido."));
      }
    });
  });
}

async function searchSoundCloud(query) {
  const text = clean(query);
  if (!text) return "";
  const info = await withTimeout(
    runYtDlpJson([
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      "--flat-playlist",
      `scsearch1:${text}`,
    ]),
    SEARCH_TIMEOUT_MS,
    "A busca no SoundCloud demorou demais."
  );
  const entries = Array.isArray(info.entries) ? info.entries : [];
  const first = entries.find((entry) => entry && (entry.webpage_url || entry.url));
  return first?.webpage_url || first?.url || "";
}

/** Search YouTube and return one normalized song. */
export async function searchSong(query) {
  const text = clean(query);
  if (!text) throw new Error("Digite o nome da música. Ex.: !play Michael Jackson - Billie Jean");

  if (YOUTUBE_URL.test(text)) {
    try {
      const info = await withTimeout(
        play.video_basic_info(text),
        SEARCH_TIMEOUT_MS,
        "O YouTube demorou para responder."
      );
      const details = info.video_details;
      return {
        title: clean(details.title) || text,
        url: details.url || text,
        durationSec: Number(details.durationInSec) || 0,
        thumbnail: details.thumbnails?.[0]?.url || "",
        query: text,
      };
    } catch {
      const info = await withTimeout(
        runYtDlpJson([
          "--dump-single-json",
          "--no-warnings",
          "--no-playlist",
          "--skip-download",
          text,
        ]),
        SEARCH_TIMEOUT_MS,
        "O YouTube demorou para responder."
      );
      return {
        title: clean(info.title) || text,
        url: info.webpage_url || info.original_url || text,
        durationSec: Number(info.duration) || 0,
        thumbnail: info.thumbnail || "",
        query: text,
      };
    }
  }

  try {
    const results = await withTimeout(
      play.search(text, { limit: 1 }),
      SEARCH_TIMEOUT_MS,
      "A busca no YouTube demorou demais."
    );
    const video = results?.[0];
    if (video?.url) {
      return {
        title: clean(video.title) || text,
        url: video.url,
        durationSec: Number(video.durationInSec) || 0,
        thumbnail: video.thumbnail?.url || "",
        query: text,
      };
    }
  } catch (error) {
    console.warn(`[song] play-dl search falhou: ${error?.message || error}`);
  }

  const info = await withTimeout(
    runYtDlpJson([
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--flat-playlist",
      `ytsearch1:${text}`,
    ]),
    SEARCH_TIMEOUT_MS,
    "A busca no YouTube demorou demais."
  );

  const title = clean(info.title) || text;
  const url = info.webpage_url || info.url || `https://www.youtube.com/watch?v=${youtubeId(info.id || "")}`;
  if (!url || !youtubeId(url)) throw new Error("Nenhuma música encontrada no YouTube.");

  return {
    title,
    url,
    durationSec: Number(info.duration) || 0,
    thumbnail: info.thumbnail || "",
    query: text,
  };
}

function openYtDlp(url) {
  if (!YTDLP_READY) throw new Error("binário do yt-dlp não instalado (rode npm install).");
  const child = spawn(
    YTDLP,
    [
      "--format",
      "bestaudio/best",
      "--output",
      "-",
      "--no-warnings",
      "--no-progress",
      "--no-playlist",
      "--quiet",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });

  const stream = new PassThrough();
  child.stdout.pipe(stream);

  let firstChunk = false;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      firstChunk = true;
      try {
        stream.pause();
        stream.unshift(chunk);
      } catch {
        /* ignora */
      }
      finish();
    };
    const onError = (error) => finish(error);
    const onClose = (code) => {
      if (code !== 0) {
        const reason = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
        finish(new Error(reason || `yt-dlp terminou com código ${code}`));
      } else if (!firstChunk) {
        finish(new Error("yt-dlp terminou sem entregar áudio."));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("yt-dlp não entregou áudio em 15s.")),
      15_000
    );
    stream.once("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });

  return {
    kind: "yt-dlp",
    stream,
    ready,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignora */
      }
      try {
        stream.destroy();
      } catch {
        /* ignora */
      }
    },
  };
}

async function openPlayDl(url) {
  const result = await play.stream(url);
  if (!result?.stream) throw new Error("play-dl não retornou áudio.");
  return {
    kind: "play-dl",
    stream: result.stream,
    ready: Promise.resolve(),
    kill() {
      try {
        result.stream.destroy();
      } catch {
        /* ignora */
      }
    },
  };
}

function openYtdlCore(url) {
  const stream = ytdl(url, {
    filter: "audioonly",
    quality: "highestaudio",
    highWaterMark: 1 << 25,
  });
  return {
    kind: "ytdl-core",
    stream,
    ready: Promise.resolve(),
    kill() {
      try {
        stream.destroy();
      } catch {
        /* ignora */
      }
    },
  };
}

async function preflight(source, label, errors) {
  try {
    await source.ready;
    return source;
  } catch (error) {
    source.kill?.();
    errors.push(`${label}: ${error?.message || error}`);
    return null;
  }
}

/** Open the best available audio source for a song. */
export async function openAudio(song) {
  const url = clean(song?.url);
  if (!url) throw new Error("Música sem URL do YouTube.");

  const errors = [];

  try {
    const source = await preflight(openYtDlp(url), "YouTube yt-dlp", errors);
    if (source) return source;
  } catch (error) {
    errors.push(`YouTube yt-dlp: ${error?.message || error}`);
  }

  // O IP de datacenter do Render costuma ser bloqueado pelo YouTube. O
  // SoundCloud não tem esse challenge; o título original continua no chat.
  const fallbackQuery = clean(song?.title) || clean(song?.query);
  if (fallbackQuery) {
    try {
      const soundcloudUrl = await searchSoundCloud(fallbackQuery);
      if (soundcloudUrl) {
        const source = await preflight(
          openYtDlp(soundcloudUrl),
          "SoundCloud yt-dlp",
          errors
        );
        if (source) return { ...source, kind: "yt-dlp-soundcloud" };
      }
    } catch (error) {
      errors.push(`SoundCloud: ${error?.message || error}`);
    }
  }

  try {
    return await openPlayDl(url);
  } catch (error) {
    errors.push(`play-dl: ${error?.message || error}`);
  }

  try {
    return openYtdlCore(url);
  } catch (error) {
    errors.push(`ytdl-core: ${error?.message || error}`);
  }

  throw new Error(`Não consegui abrir o áudio: ${errors.join(" | ")}`);
}

/** Open a live MP3 stream (ffmpeg transcodes the YouTube audio in real time). */
export async function openMp3Stream(song) {
  if (!ffmpegPath) throw new Error("ffmpeg-static não está disponível neste servidor.");

  const source = await openAudio(song);
  const ffmpeg = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  const mp3 = new PassThrough();
  ffmpeg.stdout.pipe(mp3);
  ffmpeg.on("error", (error) => {
    console.warn(`[song] ffmpeg não iniciou: ${error?.message || error}`);
    mp3.destroy(error);
  });

  source.stream.on("error", (error) => {
    console.warn(`[song] fonte ${source.kind} falhou: ${error?.message || error}`);
    try {
      ffmpeg.stdin.destroy(error);
    } catch {
      /* ignora */
    }
    mp3.destroy(error);
  });
  source.stream.pipe(ffmpeg.stdin);

  ffmpeg.stderr?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.warn(`[song] ffmpeg: ${line.slice(0, 300)}`);
  });

  return {
    kind: source.kind,
    process: ffmpeg,
    source,
    stream: mp3,
    kill() {
      source.kill();
      try {
        ffmpeg.kill("SIGKILL");
      } catch {
        /* ignora */
      }
      try {
        mp3.destroy();
      } catch {
        /* ignora */
      }
    },
  };
}
