import axios from "axios";
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const SCRAPE_TTL = 30 * 60_000;
const cache = new Map();

function normalizeCandidate(raw, cid) {
  let value = String(raw || "").trim();
  if (!value || value.startsWith("data:")) return "";
  value = value.replace(/&amp;/g, "&").replace(/\\\//g, "/");
  const outfit = value.match(/outfit-(\d+)-(\d+)/i);
  if (!outfit) return "";
  if (cid && outfit[1] !== String(cid)) return "";
  if (/rendered_image\/outfit-/i.test(value)) {
    if (value.startsWith("//")) return `https:${value}`;
    if (/^https?:\/\//i.test(value)) return value;
    const index = value.indexOf("rendered_image/");
    return `https://api.imvu.com/${value.slice(index)}`;
  }
  return `https://api.imvu.com/rendered_image/${outfit[0].toLowerCase()}`;
}

/**
 * Tenta raspar a pagina publica do perfil em busca de imagens
 * rendered_image/outfit-<cid>-<id>. Se o IMVU bloquear (403/429)
 * ou nao houver nada, retorna [].
 */
export async function scrapingOutfits(nick, cid = "") {
  const clean = String(nick || "").trim();
  if (!clean) return [];
  const cacheKey = `${clean.toLowerCase()}:${cid || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < SCRAPE_TTL) return cached.images;

  const urls = [
    `https://www.imvu.com/next/u/${encodeURIComponent(clean)}/`,
    `https://www.imvu.com/user/${encodeURIComponent(clean)}/`,
  ];
  const found = new Set();

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        timeout: 10_000,
        maxRedirects: 5,
        responseType: "text",
        validateStatus: () => true,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
      });
      if (response.status < 200 || response.status >= 300) continue;
      const html = String(response.data || "");
      if (!html) continue;

      const add = (raw) => {
        const image = normalizeCandidate(raw, cid);
        if (image) found.add(image);
      };

      const $ = cheerio.load(html);
      $("img").each((_, element) => {
        const node = $(element);
        add(node.attr("src"));
        add(node.attr("data-src"));
        add(node.attr("srcset"));
      });
      $("a, [data-outfit], [data-image], [data-src], [data-url]").each((_, element) => {
        const node = $(element);
        for (const attr of ["href", "src", "data-src", "data-image", "data-outfit", "data-url"]) {
          add(node.attr(attr));
        }
      });

      // HTML/JSON embutido: pega URLs que o cheerio nao ve como tag.
      const regex =
        /(?:https?:)?\/\/[^"'\s]*rendered_image\/outfit-\d+-\d+[^"'\s]*|rendered_image\/outfit-\d+-\d+/gi;
      for (const match of html.match(regex) || []) add(match);
    } catch {
      // 403/429/timeout: tenta a proxima URL; ao final retorna o que achou.
    }
  }

  const images = [...found].slice(0, 24);
  cache.set(cacheKey, { at: Date.now(), images });
  return images;
}
