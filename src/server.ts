import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { env, now } from "./config.ts";
import { checkPending, checkTasks, dailyDigest, handleOps } from "./ops.ts";
import { checkFollowups, handleEnquiry, handleSales } from "./sales.ts";
import { parseIncoming, type Channel, type Incoming } from "./whapi.ts";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Messages in the same chat are handled one after another so replies never overlap or go out of order.
const queues = new Map<string, Promise<void>>();
export function enqueue(channel: Channel, m: Incoming) {
  const key = `${channel}:${m.chatId}`;
  const live = now() - m.ts < 600; // older messages (backlog after a reconnect) are stored but not acted on
  const next = (queues.get(key) ?? Promise.resolve())
    .then(() => (channel === "ops" ? handleOps(m, live) : handleSales(m, live)))
    .catch((e) => console.error(`[${channel}] failed handling ${m.id}:`, e));
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 404, { error: "not found" });

    // WhatsApp provider webhook: /webhooks/whapi/<ops|sales>/<WEBHOOK_SECRET>
    const hook = path.match(/^\/webhooks\/whapi\/(ops|sales)\/([^/]+)$/);
    if (hook) {
      if (!env.webhookSecret || !safeEqual(hook[2], env.webhookSecret)) return send(res, 401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(req));
      send(res, 200, { ok: true }); // acknowledge first; the provider retries slow webhooks
      for (const raw of Array.isArray(body?.messages) ? body.messages : []) {
        const m = parseIncoming(raw);
        if (m) void enqueue(hook[1] as Channel, m);
      }
      return;
    }

    // Website enquiry webhook, signed by the site with HMAC-SHA256 (x-unispire-signature).
    if (path === "/webhooks/enquiry") {
      if (!env.enquirySecret) return send(res, 503, { error: "ENQUIRY_WEBHOOK_SECRET not configured" });
      const raw = await readBody(req);
      const expected = createHmac("sha256", env.enquirySecret).update(raw).digest("hex");
      if (!safeEqual(String(req.headers["x-unispire-signature"] ?? ""), expected)) return send(res, 401, { error: "bad signature" });
      send(res, 200, { ok: true });
      handleEnquiry(JSON.parse(raw)).catch((e) => console.error("enquiry failed:", e));
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) send(res, 400, { error: "bad request" });
  }
});

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const job of [checkPending, checkTasks, dailyDigest, checkFollowups]) {
      try { await job(); } catch (e) { console.error(`${job.name} failed:`, e); }
    }
  } finally { ticking = false; }
}

if (import.meta.main) {
  if (!env.dryRun) {
    const missing = [
      !env.webhookSecret && "WEBHOOK_SECRET",
      !env.opsToken && !env.salesToken && "WHAPI_OPS_TOKEN or WHAPI_SALES_TOKEN",
      !env.fakeLlm && !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
    ].filter(Boolean);
    if (missing.length) { console.error(`Cannot start, missing in .env: ${missing.join(", ")}`); process.exit(1); }
  }
  server.listen(env.port, () => console.log(`WhatsApp agents listening on :${env.port}${env.dryRun ? " (DRY_RUN: nothing is sent)" : ""}`));
  setInterval(() => void tick(), 60_000);
}
