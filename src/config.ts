import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export interface Member {
  name: string;
  /** WhatsApp number, digits only with country code, e.g. 971501234567 */
  phone: string;
  /** Extra WhatsApp ids for the same person (e.g. the "lid" id WhatsApp sometimes uses in groups). */
  ids?: string[];
  role?: string;
}

export interface Config {
  timezone: string;
  workingHours: { days: number[]; start: string; end: string }; // days: 0=Sun … 6=Sat
  owner: Member;
  team: Member[];
  ops: {
    /** Which groups to watch: "all", or a list of group ids / parts of group names. Messages in other groups are not stored. */
    monitorGroups: "all" | string[];
    replySlaMinutes: number;
    escalateAfterMinutes: number;
    /** Where the "client is waiting" nudge goes: private message, internal team group, or the customer group itself. */
    nudgeWhere: "dm" | "team_group" | "customer_group";
    teamGroupId: string;
    digestTime: string;
    defaultAssignee: string;
  };
  sales: {
    /** "leads": only talk to people the agent contacted first (website enquiry or the owner's instruction). "everyone": answer anyone who writes to the sales number. */
    replyTo?: "leads" | "everyone";
    /** WhatsApp Business label put on a chat when the client shows interest. */
    interestedLabel?: string;
    agentName: string;
    handoffTo: string;
    followUpDays: number[];
    humanTakeoverHours: number;
  };
}

const configFile = process.env.CONFIG_PATH || path.join(ROOT, "config.json");
if (!fs.existsSync(configFile)) {
  throw new Error(`Missing ${configFile}. Copy config.example.json to config.json and fill it in.`);
}
export const config: Config = JSON.parse(fs.readFileSync(configFile, "utf8"));

export const env = {
  port: Number(process.env.PORT || 8787),
  dbPath: process.env.DB_PATH || path.join(ROOT, "data.sqlite"),
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  opsToken: process.env.WHAPI_OPS_TOKEN || "",
  salesToken: process.env.WHAPI_SALES_TOKEN || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  enquirySecret: process.env.ENQUIRY_WEBHOOK_SECRET || "",
  dryRun: process.env.DRY_RUN === "1",
  fakeLlm: process.env.LLM_FAKE === "1",
  replyDelayMs: Number(process.env.REPLY_DELAY_MS ?? 8000),
};

export const knowledge = (() => {
  const f = path.join(ROOT, "knowledge.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
})();

/** Strip a WhatsApp id or phone string down to digits (drops @s.whatsapp.net, +, spaces). */
export const digits = (s: string) => String(s ?? "").split("@")[0].replace(/\D/g, "");

/** Normalise a phone typed by a human into WhatsApp digits. UAE local numbers (05…) become 9715…. */
export function normalisePhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = "971" + d.slice(1);
  return d.length >= 9 && d.length <= 15 ? d : null;
}

const people = () => [config.owner, ...config.team];
export function memberById(id: string): Member | undefined {
  const d = digits(id);
  return people().find((m) => digits(m.phone) === d || (m.ids ?? []).some((x) => digits(x) === d));
}
export function memberByName(name: string): Member | undefined {
  const n = name.trim().toLowerCase();
  return people().find((m) => m.name.toLowerCase() === n) ?? people().find((m) => m.name.toLowerCase().includes(n));
}
export const isOwner = (id: string) => memberById(id) === config.owner;

export function isMonitoredGroup(chatId: string, name: string) {
  const list = config.ops.monitorGroups ?? "all";
  if (list === "all") return true;
  const n = name.toLowerCase();
  return list.some((x) => x === chatId || (!x.endsWith("@g.us") && n !== "" && n.includes(x.toLowerCase())));
}

// ---- time helpers (all in the configured timezone) ----
function local(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
  };
}
export const localDate = (d = new Date()) => local(d).date;
export const localTime = (d = new Date()) => local(d).hm;
export const nowText = (d = new Date()) => `${local(d).date} ${local(d).hm} (${config.timezone})`;

export function inWorkingHours(d = new Date()) {
  const l = local(d);
  const w = config.workingHours;
  return w.days.includes(l.dow) && l.hm >= w.start && l.hm < w.end;
}

/** Epoch seconds at which today's working window opened (used so overnight messages start their clock in the morning). */
export function workStartToday(d = new Date()) {
  const l = local(d);
  const [h, m] = config.workingHours.start.split(":").map(Number);
  const [ch, cm] = l.hm.split(":").map(Number);
  return Math.floor(d.getTime() / 1000) - ((ch - h) * 3600 + (cm - m) * 60);
}

export const now = () => Math.floor(Date.now() / 1000);
