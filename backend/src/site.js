// URL pública do frontend usada nos links de notificação/push.
// O deploy oficial agora é o GitHub Pages; valores antigos da Netlify são ignorados.
export const DEFAULT_SITE_URL = "https://ronilsondesouza045-beep.github.io/imvu-site";

const LEGACY_SITE_URLS = new Set([
  "https://imvu-radar-web.netlify.app",
]);

const normalize = (value) => String(value || "").trim().replace(/\/+$/, "");

const configured =
  normalize(process.env.PUBLIC_SITE_URL) || normalize(process.env.SITE_URL);

export const SITE_URL =
  configured && !LEGACY_SITE_URLS.has(configured) ? configured : DEFAULT_SITE_URL;
