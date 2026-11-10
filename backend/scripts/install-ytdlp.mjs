import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(__dirname, "..", "bin");
const windows = process.platform === "win32";
const filename = windows ? "yt-dlp.exe" : "yt-dlp";
const destination = path.join(binDir, filename);

const assetForPlatform = () => {
  if (windows) return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
  return "yt-dlp_linux";
};

const main = async () => {
  await fsp.mkdir(binDir, { recursive: true });
  if (fs.existsSync(destination) && fs.statSync(destination).size > 1_000_000) {
    console.log(`[yt-dlp] binário já existe: ${destination}`);
    return;
  }

  const assetName = assetForPlatform();
  console.log(`[yt-dlp] baixando ${assetName}...`);
  const headers = { "User-Agent": "imvu-radar-backend" };
  const releaseResponse = await fetch(
    "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
    { headers }
  );
  if (!releaseResponse.ok) {
    throw new Error(`GitHub API respondeu ${releaseResponse.status}`);
  }
  const release = await releaseResponse.json();
  const asset =
    release.assets?.find((item) => item.name === assetName) ||
    release.assets?.find((item) => item.name === "yt-dlp") ||
    release.assets?.find((item) => item.name === "yt-dlp.exe");
  if (!asset?.browser_download_url) {
    throw new Error(`Asset ${assetName} não encontrado no release do yt-dlp.`);
  }

  const download = await fetch(asset.browser_download_url, { headers });
  if (!download.ok) throw new Error(`Download do yt-dlp falhou: HTTP ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.length < 1_000_000) throw new Error("Download do yt-dlp veio vazio/curto.");

  await fsp.writeFile(destination, buffer, { mode: 0o755 });
  if (!windows) await fsp.chmod(destination, 0o755);
  console.log(`[yt-dlp] instalado em ${destination} (${buffer.length} bytes)`);
};

main().catch((error) => {
  console.error(`[yt-dlp] falhou: ${error?.message || error}`);
  // Não derruba o build: o bot ainda tem play-dl/ytdl-core como fallback.
});
