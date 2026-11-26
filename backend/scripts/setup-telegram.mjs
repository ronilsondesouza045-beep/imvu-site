#!/usr/bin/env node
/**
 * Configura o bot do Telegram de ponta a ponta depois que o token existir.
 *
 * Uso:
 *   node scripts/setup-telegram.mjs <TOKEN>
 *   node scripts/setup-telegram.mjs            (pergunta o token, oculto no terminal)
 *
 * O que ele faz:
 *   1. Valida o token no getMe (confirma o @username real do bot).
 *   2. Grava TELEGRAM_TOKEN no backend/.env (com backup .env.bak).
 *   3. Troca o link https://t.me/SEU_BOT_USERNAME no frontend/index.html.
 *   4. Registra os comandos /start /status /fit /parar no menu do bot.
 *
 * Nada é gravado se o token for inválido.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "..");
const ENV_FILE = path.join(BACKEND_DIR, ".env");
const INDEX_FILE = path.join(BACKEND_DIR, "..", "frontend", "index.html");
const API = "https://api.telegram.org";

const COMMANDS = [
  { command: "start", description: "Abrir o menu de opções" },
  { command: "status", description: "Sala atual de um nick" },
  { command: "fit", description: "Avatar 2D de um nick" },
  { command: "parar", description: "Cancelar monitoramento" },
];

function fail(message) {
  console.error(`\n[erro] ${message}`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      // Sem TTY (pipe/CI): leitura normal.
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question(question).then((answer) => {
        rl.close();
        resolve(answer.trim());
      }, reject);
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (char) => {
      if (char === "\r" || char === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (char === "\u0003") {
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(1);
      }
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on("data", onData);
  });
}

async function telegram(token, method, payload) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* resposta não-JSON */
  }
  if (!json?.ok) {
    throw new Error(json?.description || `HTTP ${response.status}`);
  }
  return json.result;
}

function saveTokenToEnv(token) {
  let content = "";
  try {
    content = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    content = "# Servidor\nPORT=8080\n";
  }
  try {
    fs.writeFileSync(`${ENV_FILE}.bak`, content, "utf8");
  } catch {
    /* backup é opcional */
  }

  const line = `TELEGRAM_TOKEN=${token}`;
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((current) => {
    if (/^\s*TELEGRAM_TOKEN\s*=/.test(current)) {
      replaced = true;
      return line;
    }
    return current;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] === "") next.pop();
    next.push("", "# ---------------- Telegram Bot ----------------", line, "");
  }
  fs.writeFileSync(ENV_FILE, next.join("\n"), "utf8");
  return replaced;
}

function saveUsernameToFrontend(username) {
  let html;
  try {
    html = fs.readFileSync(INDEX_FILE, "utf8");
  } catch {
    return false;
  }
  const url = `https://t.me/${username}`;
  let next = html.replace(/https:\/\/t\.me\/SEU_BOT_USERNAME/g, url);
  // Reexecução com outro bot: atualiza o href do banner.
  next = next.replace(
    /(<a\s+class="telegram-banner-btn"\s+href=")https:\/\/t\.me\/[A-Za-z0-9_]+(")/,
    `$1${url}$2`
  );
  if (next === html) return false;
  fs.writeFileSync(INDEX_FILE, next, "utf8");
  return true;
}

async function main() {
  let token = String(process.argv[2] || "").trim();
  if (!token) {
    console.log("Token do @BotFather (não aparece enquanto você cola):");
    token = await askHidden("TELEGRAM_TOKEN> ");
  }
  if (!token) fail("token vazio");
  if (!/^\d+:[\w-]{10,}$/.test(token)) {
    fail("formato inválido. O token é algo como 123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  }

  console.log("\n[1/4] Validando token no Telegram...");
  let me;
  try {
    me = await telegram(token, "getMe");
  } catch (error) {
    fail(`Telegram recusou o token: ${error.message}`);
  }
  const username = me.username;
  console.log(`      ok: bot @${username} (${me.first_name})`);

  console.log("[2/4] Gravando TELEGRAM_TOKEN no backend/.env...");
  const replaced = saveTokenToEnv(token);
  console.log(`      ok (${replaced ? "linha existente atualizada" : "linha adicionada"}) · backup .env.bak`);

  console.log("[3/4] Atualizando o link do bot no frontend/index.html...");
  const changed = saveUsernameToFrontend(username);
  console.log(
    changed
      ? `      ok: botão aponta para https://t.me/${username}`
      : `      aviso: placeholder não encontrado; confira o href em frontend/index.html`
  );

  console.log("[4/4] Registrando comandos no menu do bot...");
  try {
    await telegram(token, "setMyCommands", { commands: COMMANDS });
    console.log("      ok: /start /status /fit /parar");
  } catch (error) {
    console.log(`      aviso: não consegui registrar os comandos (${error.message})`);
  }

  console.log(`
============================================================
 Tudo configurado.

 Bot:     @${username}
 Link:    https://t.me/${username}
 Token:   gravado em backend/.env

 Agora inicie o backend (site + bot no mesmo processo):

     cd backend
     npm start

 Depois abra https://t.me/${username} no Telegram e pressione
 START. Sem esse clique o bot não consegue te enviar alertas.
============================================================`);
}

main().catch((error) => fail(error?.message || String(error)));
