import webpush from "web-push";

const publicKey = String(process.env.VAPID_PUBLIC_KEY || "");
const privateKey = String(process.env.VAPID_PRIVATE_KEY || "");
const subject = String(process.env.VAPID_SUBJECT || "mailto:contato@imvu-radar.local");
const available = Boolean(publicKey && privateKey);

if (available) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export function pushAvailable() {
  return available;
}

export function pushPublicKey() {
  return publicKey;
}

export async function sendPush(subscription, payload) {
  if (!available) throw new Error("push nao configurado");
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}
