import { DatabaseSync } from "node:sqlite";
import { env, now } from "./config.ts";

export const db = new DatabaseSync(env.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT, sender_name TEXT,
  role TEXT NOT NULL,            -- customer | team | bot
  body TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (channel, chat_id, ts);
CREATE TABLE IF NOT EXISTS groups (chat_id TEXT PRIMARY KEY, name TEXT, owner TEXT);
CREATE TABLE IF NOT EXISTS pending (  -- one open "client is waiting" thread per group
  chat_id TEXT PRIMARY KEY, since_ts INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
  summary TEXT, nudged_at INTEGER, escalated_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assignee TEXT NOT NULL, text TEXT NOT NULL, group_name TEXT,
  due_ts INTEGER, status TEXT NOT NULL DEFAULT 'open',  -- open | done | blocked
  note TEXT, created_ts INTEGER NOT NULL, next_ping_ts INTEGER NOT NULL, pings INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leads (
  chat_id TEXT PRIMARY KEY, name TEXT, details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',  -- active | handoff | stopped | cold
  paused_until INTEGER NOT NULL DEFAULT 0, followups_sent INTEGER NOT NULL DEFAULT 0,
  next_followup_ts INTEGER, last_in_ts INTEGER, last_out_ts INTEGER, created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS usage (  -- one row per Claude API call
  ts INTEGER NOT NULL, day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_day ON usage (day);
`);

export type Row = Record<string, any>;
export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const get = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

export interface StoredMessage {
  id: string; channel: string; chat_id: string; sender: string; sender_name: string;
  role: "customer" | "team" | "bot"; body: string; ts: number;
}

/** Returns false when the message id was already stored (duplicate webhook delivery). */
export function saveMessage(m: StoredMessage) {
  const r = run(
    "INSERT OR IGNORE INTO messages (id, channel, chat_id, sender, sender_name, role, body, ts) VALUES (?,?,?,?,?,?,?,?)",
    m.id, m.channel, m.chat_id, m.sender, m.sender_name, m.role, m.body, m.ts,
  );
  return r.changes > 0;
}

export function recent(channel: string, chatId: string, limit: number): StoredMessage[] {
  return (all("SELECT * FROM messages WHERE channel=? AND chat_id=? ORDER BY ts DESC, rowid DESC LIMIT ?", channel, chatId, limit) as StoredMessage[]).reverse();
}

export const transcript = (msgs: StoredMessage[]) =>
  msgs.map((m) => `[${new Date(m.ts * 1000).toISOString().slice(0, 16).replace("T", " ")}Z] ${m.role.toUpperCase()} ${m.sender_name || m.sender}: ${m.body}`).join("\n");

export function findGroup(q: string): Row | undefined {
  return get("SELECT * FROM groups WHERE chat_id=?", q)
    ?? get("SELECT * FROM groups WHERE lower(name)=lower(?)", q)
    ?? get("SELECT * FROM groups WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY length(name) LIMIT 1", q);
}

export const kvGet = (k: string) => get("SELECT value FROM kv WHERE key=?", k)?.value as string | undefined;
export const kvSet = (k: string, v: string) => run("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v);

export function createTask(assignee: string, text: string, dueTs: number | null, groupName: string | null) {
  const t = now();
  const r = run("INSERT INTO tasks (assignee, text, group_name, due_ts, created_ts, next_ping_ts) VALUES (?,?,?,?,?,?)",
    assignee, text, groupName, dueTs, t, dueTs ?? t + 4 * 3600);
  return Number(r.lastInsertRowid);
}
