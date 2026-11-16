import { randomUUID } from "node:crypto";
import { digits, env, now } from "./config.ts";
import { saveMessage } from "./db.ts";

export type Channel = "ops" | "sales";

/** Messages sent while DRY_RUN=1 (nothing leaves the machine); used by the simulator. */
export const outbox: { channel: Channel; to: string; body: string }[] = [];

const tokenFor = (c: Channel) => (c === "ops" ? env.opsToken : env.salesToken);
export const channelReady = (c: Channel) => env.dryRun || Boolean(tokenFor(c));

export const toChatId = (to: string) => (to.includes("@") ? to : `${digits(to)}@s.whatsapp.net`);

export async function sendText(channel: Channel, to: string, body: string, mentions: string[] = []) {
  const chatId = toChatId(to);
  let id = `out-${randomUUID()}`;
  if (env.dryRun) {
    outbox.push({ channel, to: chatId, body });
    console.log(`[dry-run ${channel} -> ${chatId}] ${body}`);
  } else {
    const token = tokenFor(channel);
    if (!token) throw new Error(`No WhatsApp token configured for the ${channel} channel`);
    const res = await fetch("https://gate.whapi.cloud/messages/text", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // typing_time makes the message appear after a short "typing…" pause, like a person.
      body: JSON.stringify({ to: chatId, body, typing_time: Math.min(8, 1 + Math.floor(body.length / 60)), ...(mentions.length ? { mentions } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Whapi send failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    id = json?.message?.id ?? id;
  }
  saveMessage({ id, channel, chat_id: chatId, sender: "bot", sender_name: "Agent", role: "bot", body, ts: now() });
}

/** Send without throwing: scheduler jobs should keep going if one recipient fails. */
export async function trySend(channel: Channel, to: string, body: string, mentions: string[] = []) {
  try { await sendText(channel, to, body, mentions); return true; }
  catch (e) { console.error(`send to ${to} failed:`, e instanceof Error ? e.message : e); return false; }
}

export interface Incoming {
  id: string; chatId: string; chatName: string; from: string; fromName: string;
  fromMe: boolean; source: string; body: string; ts: number; isGroup: boolean;
}

/** Map one Whapi webhook message object to our shape. Non-text messages become a short placeholder. */
export function parseIncoming(m: any): Incoming | null {
  if (!m?.id || !m?.chat_id) return null;
  if (m.type === "action" || m.type === "system" || m.type === "revoked") return null; // reactions, joins, deletes
  const caption = m[m.type]?.caption;
  const body = m.type === "text" ? m.text?.body : `[${m.type}]${caption ? " " + caption : ""}`;
  if (!body) return null;
  return {
    id: String(m.id), chatId: String(m.chat_id), chatName: m.chat_name ?? "", from: String(m.from ?? ""),
    fromName: m.from_name ?? "", fromMe: Boolean(m.from_me), source: m.source ?? "", body: String(body),
    ts: Number(m.timestamp) || now(), isGroup: String(m.chat_id).endsWith("@g.us"),
  };
}

const labelIds = new Map<string, string>();

/** Put a WhatsApp Business label (by its name) on a chat. Returns false if the label does not exist or the call fails. */
export async function addLabel(channel: Channel, chatId: string, labelName: string) {
  if (env.dryRun) { console.log(`[dry-run ${channel}] label "${labelName}" -> ${chatId}`); return true; }
  try {
    const headers = { authorization: `Bearer ${tokenFor(channel)}` };
    const key = `${channel}:${labelName.toLowerCase()}`;
    if (!labelIds.has(key)) {
      const list: any = await (await fetch("https://gate.whapi.cloud/labels", { headers, signal: AbortSignal.timeout(30_000) })).json();
      // WhatsApp pads some label names with invisible characters, so compare on letters and digits only.
      const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const found = (Array.isArray(list) ? list : []).find((l) => norm(l.name ?? "") === norm(labelName));
      if (!found) return false;
      labelIds.set(key, String(found.id));
    }
    const res = await fetch(`https://gate.whapi.cloud/labels/${labelIds.get(key)}/${chatId}`, { method: "POST", headers, signal: AbortSignal.timeout(30_000) });
    return res.ok;
  } catch (e) {
    console.error("addLabel failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
