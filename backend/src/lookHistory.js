import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const dbPath = process.env.LOOK_HISTORY_DB || path.join(dataDir, "radar.db");

let db = null;
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS historico_looks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cid TEXT NOT NULL,
      image_url TEXT NOT NULL,
      data_captura TEXT NOT NULL,
      itens_json TEXT NOT NULL,
      dia TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_historico_looks_cid_dia
      ON historico_looks (cid, dia);
  `);
  console.log(`[look-history] sqlite pronto em ${dbPath}`);
} catch (error) {
  db = null;
  console.warn(`[look-history] sqlite indisponivel: ${error?.message || error}`);
}

const upsert = db?.prepare(`
  INSERT INTO historico_looks (cid, image_url, data_captura, itens_json, dia)
  VALUES (@cid, @image_url, @data_captura, @itens_json, @dia)
  ON CONFLICT(cid, dia) DO UPDATE SET
    image_url = excluded.image_url,
    data_captura = excluded.data_captura,
    itens_json = excluded.itens_json
`);

const select = db?.prepare(`
  SELECT id, cid, image_url, data_captura, itens_json
  FROM historico_looks
  WHERE cid = ?
  ORDER BY data_captura DESC
  LIMIT ?
`);

/** Salva (ou atualiza) o look do dia. Evita duplicata no mesmo dia por cid. */
export function saveLookHistory(cid, imageUrl, items = [], capturedAt = new Date()) {
  if (!db || !upsert) return false;
  const id = String(cid || "");
  const image = String(imageUrl || "").trim();
  if (!/^\d+$/.test(id) || !image) return false;
  const date = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return false;
  const dataCaptura = date.toISOString();
  const dia = dataCaptura.slice(0, 10);
  const safeItems = Array.isArray(items) ? items.slice(0, 200) : [];
  try {
    upsert.run({
      cid: id,
      image_url: image,
      data_captura: dataCaptura,
      itens_json: JSON.stringify(safeItems),
      dia,
    });
    return true;
  } catch (error) {
    console.warn(`[look-history] falha ao salvar: ${error?.message || error}`);
    return false;
  }
}

/** Historico de looks capturados, mais recentes primeiro. */
export function getLookHistory(cid, limit = 12) {
  if (!db || !select) return [];
  const id = String(cid || "");
  if (!/^\d+$/.test(id)) return [];
  const max = Math.max(1, Math.min(50, Number(limit) || 12));
  try {
    return select.all(id, max).map((row) => {
      let items = [];
      try {
        items = JSON.parse(row.itens_json || "[]");
      } catch {
        items = [];
      }
      const safeItems = Array.isArray(items) ? items : [];
      const total = safeItems.reduce((sum, item) => sum + (Number(item?.price) || 0), 0);
      return {
        id: row.id,
        cid: row.cid,
        image_url: row.image_url,
        data_captura: row.data_captura,
        items: safeItems,
        total_credits: total,
        item_count: safeItems.length,
      };
    });
  } catch {
    return [];
  }
}
