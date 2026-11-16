/**
 * Operations agent: sits in every customer group on the "ops" WhatsApp number.
 * - Reads all group messages and tracks whether the client is waiting for a team reply.
 * - Chases the team (never the customer) when a reply is late, then escalates to the owner.
 * - Takes instructions from the owner by private message and follows up on tasks with the team.
 */
import { z } from "zod";
import {
  config, digits, inWorkingHours, isOwner, localDate, localTime, memberById, memberByName, now, nowText, workStartToday,
  type Member,
} from "./config.ts";
import { all, createTask, findGroup, get, kvGet, kvSet, recent, run, saveMessage, transcript } from "./db.ts";
import { runAgent, tool, triage, type ToolSpec, type Turn } from "./llm.ts";
import { trySend, type Incoming } from "./whapi.ts";

const mins = (s: number) => Math.max(1, Math.round(s / 60));

export async function handleOps(m: Incoming, live: boolean) {
  if (m.fromMe && m.source === "api") return; // our own sends echoed back
  const member = memberById(m.from);

  if (m.isGroup) {
    // Anything typed by a known team number, or by a person using the ops phone itself, counts as a team reply.
    const role = m.fromMe || member ? "team" : "customer";
    run("INSERT INTO groups (chat_id, name) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE name END",
      m.chatId, m.chatName);
    const fresh = saveMessage({ id: m.id, channel: "ops", chat_id: m.chatId, sender: digits(m.from), sender_name: member?.name ?? m.fromName, role, body: m.body, ts: m.ts });
    if (!fresh || m.chatId === config.ops.teamGroupId) return;
    if (role === "team") run("DELETE FROM pending WHERE chat_id=?", m.chatId);
    else run("INSERT OR IGNORE INTO pending (chat_id, since_ts) VALUES (?,?)", m.chatId, m.ts);
    return;
  }

  // Private messages: only the owner and team members may talk to the agent.
  if (m.fromMe || !member) return;
  const fresh = saveMessage({ id: m.id, channel: "ops", chat_id: m.chatId, sender: digits(m.from), sender_name: member.name, role: "team", body: m.body, ts: m.ts });
  if (!fresh || !live) return;

  const owner = isOwner(m.from);
  const turns: Turn[] = recent("ops", m.chatId, 20).map((x) => ({ role: x.role === "bot" ? "assistant" : "user", content: x.body }));
  while (turns.length && turns[0].role === "assistant") turns.shift();
  const reply = await runAgent({
    system: owner ? ownerPrompt() : teamPrompt(member),
    turns,
    tools: owner ? ownerTools() : teamTools(member),
  });
  if (reply) await trySend("ops", m.chatId, reply);
}

// ---------- prompts ----------

const roster = () => config.team.map((t) => `- ${t.name}${t.role ? ` (${t.role})` : ""}`).join("\n");

const ownerPrompt = () => `You are the operations assistant for ${config.owner.name}, who runs a UAE business-setup consultancy. You are a WhatsApp account that is a member of every customer group. ${config.owner.name} is messaging you privately.

What you do:
- Answer questions about what is happening in customer groups, using the tools to read them. Report facts from the messages; say so when you cannot find something.
- Turn instructions into tasks for team members and message them. The system reminds assignees automatically and tells ${config.owner.name} when a task is overdue or done.
- Pass messages to team members when asked.

You never write to customers. You only talk to ${config.owner.name} and the team.

Team:
${roster()}

Write the way a capable assistant texts their boss on WhatsApp: short, plain, no headings. WhatsApp formatting only (*bold*, lists with "-"). Reply in the language ${config.owner.name} writes in. Current time: ${nowText()}.`;

const teamPrompt = (m: Member) => `You are the operations assistant for ${config.owner.name}'s UAE business-setup consultancy. You are a WhatsApp account that follows up with the team on ${config.owner.name}'s behalf. ${m.name}${m.role ? ` (${m.role})` : ""} is messaging you privately.

Help ${m.name} with their tasks: show what is open, and record updates when they say something is done or blocked (use the tools, which also inform ${config.owner.name}). If they ask for something only ${config.owner.name} can decide, say you will pass it on and use the tool to do so.

Be brief and friendly, like a colleague on WhatsApp. Reply in the language ${m.name} writes in. Current time: ${nowText()}.`;

// ---------- tools ----------

function describeTask(t: Record<string, any>) {
  const due = t.due_ts ? `, due ${new Date(t.due_ts * 1000).toISOString().slice(0, 16).replace("T", " ")}Z` : "";
  return `#${t.id} [${t.status}] ${t.assignee}: ${t.text}${t.group_name ? ` (group: ${t.group_name})` : ""}${due}${t.note ? ` | note: ${t.note}` : ""}`;
}

export function ownerTools(): ToolSpec[] {
  return [
    tool({
      name: "list_groups",
      description: "List customer groups the agent is in, with the team member responsible for each and whether a client is currently waiting for a reply.",
      schema: z.object({}),
      run: () => {
        const rows = all(`SELECT g.name, g.owner, p.since_ts, (SELECT max(ts) FROM messages m WHERE m.chat_id=g.chat_id) last_ts
                          FROM groups g LEFT JOIN pending p ON p.chat_id=g.chat_id ORDER BY last_ts DESC LIMIT 200`);
        return rows.length ? rows.map((r) => `${r.name || "(unnamed)"} | responsible: ${r.owner ?? config.ops.defaultAssignee} | ${r.since_ts ? `client waiting ${mins(now() - r.since_ts)} min` : "no one waiting"}`).join("\n") : "No groups seen yet.";
      },
    }),
    tool({
      name: "read_group",
      description: "Read the most recent messages in one customer group. Use this before answering any question about a client or a conversation.",
      schema: z.object({ group: z.string().describe("Group name or part of it"), limit: z.number().int().min(1).max(150).default(40) }),
      run: ({ group, limit }) => {
        const g = findGroup(group);
        if (!g) return `No group matching "${group}". Use list_groups to see the names.`;
        return `Group: ${g.name}\n${transcript(recent("ops", g.chat_id, limit)) || "(no messages stored yet)"}`;
      },
    }),
    tool({
      name: "open_items",
      description: "Show everything currently open: clients waiting for a reply, and tasks that are open or blocked.",
      schema: z.object({}),
      run: () => {
        const waiting = all("SELECT g.name, p.since_ts, p.summary FROM pending p JOIN groups g ON g.chat_id=p.chat_id ORDER BY p.since_ts");
        const tasks = all("SELECT * FROM tasks WHERE status<>'done' ORDER BY created_ts");
        return `Clients waiting:\n${waiting.map((w) => `- ${w.name}: ${mins(now() - w.since_ts)} min${w.summary ? ` (${w.summary})` : ""}`).join("\n") || "none"}\n\nTasks:\n${tasks.map(describeTask).join("\n") || "none"}`;
      },
    }),
    tool({
      name: "create_task",
      description: "Assign a task to a team member. Sends them the task on WhatsApp now; the system reminds them at the due time and daily after that until it is done.",
      schema: z.object({
        assignee: z.string().describe("Team member name"),
        text: z.string().describe("What needs to be done, written so the assignee understands it without other context"),
        due_in_hours: z.number().positive().optional().describe("Hours from now until it is due. Omit if no deadline was given."),
        group: z.string().optional().describe("Related customer group name, if any"),
      }),
      run: async ({ assignee, text, due_in_hours, group }) => {
        const m = memberByName(assignee);
        if (!m || m === config.owner) return `No team member called "${assignee}". Team: ${config.team.map((t) => t.name).join(", ")}`;
        const g = group ? findGroup(group) : undefined;
        const id = createTask(m.name, text, due_in_hours ? now() + Math.round(due_in_hours * 3600) : null, g?.name ?? group ?? null);
        const sent = await trySend("ops", m.phone,
          `📌 Task from ${config.owner.name} (#${id})\n${text}${g ? `\nGroup: ${g.name}` : ""}${due_in_hours ? `\nDue in ${due_in_hours >= 24 ? `${Math.round(due_in_hours / 24)} day(s)` : `${due_in_hours} hour(s)`}` : ""}\n\nReply here when it is done.`);
        return `Task #${id} created for ${m.name}. ${sent ? "They have been messaged." : "Could NOT message them on WhatsApp; tell the owner."}`;
      },
    }),
    tool({
      name: "update_task",
      description: "Change a task's status (done, open or blocked) or add a note.",
      schema: z.object({ id: z.number().int(), status: z.enum(["done", "open", "blocked"]), note: z.string().optional() }),
      run: ({ id, status, note }) => {
        const r = run("UPDATE tasks SET status=?, note=coalesce(?, note) WHERE id=?", status, note ?? null, id);
        return r.changes ? `Task #${id} is now ${status}.` : `No task #${id}.`;
      },
    }),
    tool({
      name: "message_team",
      description: "Send a WhatsApp message from the agent to a team member on the owner's behalf.",
      schema: z.object({ member: z.string(), text: z.string() }),
      run: async ({ member, text }) => {
        const m = memberByName(member);
        if (!m || m === config.owner) return `No team member called "${member}".`;
        return (await trySend("ops", m.phone, text)) ? `Sent to ${m.name}.` : `Could not send to ${m.name}.`;
      },
    }),
    tool({
      name: "set_group_responsible",
      description: "Set which team member is responsible for a customer group. Late-reply nudges for that group go to them.",
      schema: z.object({ group: z.string(), member: z.string() }),
      run: ({ group, member }) => {
        const g = findGroup(group), m = memberByName(member);
        if (!g) return `No group matching "${group}".`;
        if (!m) return `No team member called "${member}".`;
        run("UPDATE groups SET owner=? WHERE chat_id=?", m.name, g.chat_id);
        return `${m.name} is now responsible for ${g.name}.`;
      },
    }),
  ];
}

export function teamTools(me: Member): ToolSpec[] {
  return [
    tool({
      name: "my_tasks",
      description: "List this team member's tasks that are not done.",
      schema: z.object({}),
      run: () => all("SELECT * FROM tasks WHERE assignee=? AND status<>'done' ORDER BY created_ts", me.name).map(describeTask).join("\n") || "No open tasks.",
    }),
    tool({
      name: "update_my_task",
      description: "Record that one of this team member's tasks is done or blocked. The owner is informed automatically.",
      schema: z.object({ id: z.number().int(), status: z.enum(["done", "blocked"]), note: z.string().optional().describe("What was done, or why it is blocked") }),
      run: async ({ id, status, note }) => {
        const t = get("SELECT * FROM tasks WHERE id=? AND assignee=?", id, me.name);
        if (!t) return `Task #${id} is not one of ${me.name}'s tasks.`;
        // A blocked task is re-checked in 24h rather than at its old due time.
        run("UPDATE tasks SET status=?, note=coalesce(?, note), next_ping_ts=? WHERE id=?", status, note ?? null, now() + 24 * 3600, id);
        await trySend("ops", config.owner.phone, `${status === "done" ? "✅" : "⛔"} ${me.name}: task #${id} ${status}\n${t.text}${note ? `\nNote: ${note}` : ""}`);
        return `Task #${id} marked ${status}; ${config.owner.name} informed.`;
      },
    }),
    tool({
      name: "tell_owner",
      description: `Pass a message or question from this team member to ${config.owner.name}.`,
      schema: z.object({ text: z.string() }),
      run: async ({ text }) => ((await trySend("ops", config.owner.phone, `💬 ${me.name}: ${text}`)) ? "Passed on." : "Could not reach the owner."),
    }),
  ];
}

// ---------- scheduled work ----------

function responsibleFor(chatId: string): Member {
  const g = get("SELECT owner FROM groups WHERE chat_id=?", chatId);
  return memberByName(g?.owner ?? config.ops.defaultAssignee) ?? config.owner;
}

/** Chase late replies in customer groups. Runs every minute; acts only in working hours. */
export async function checkPending() {
  if (!inWorkingHours()) return;
  const t = now(), dayStart = workStartToday();
  for (const p of all("SELECT p.*, g.name FROM pending p JOIN groups g ON g.chat_id=p.chat_id")) {
    const since = Math.max(p.since_ts, dayStart); // a message from last night starts its clock when the office opens
    const waited = t - since;
    if (waited < config.ops.replySlaMinutes * 60) continue;

    if (!p.checked) {
      const verdict = await triage(p.name, transcript(recent("ops", p.chat_id, 15)));
      if (!verdict.needs_reply) { run("DELETE FROM pending WHERE chat_id=?", p.chat_id); continue; }
      run("UPDATE pending SET checked=1, summary=? WHERE chat_id=?", verdict.summary, p.chat_id);
      p.summary = verdict.summary;
    }

    const who = responsibleFor(p.chat_id);
    if (!p.nudged_at) {
      const text = `⏰ *${p.name}*: client waiting ${mins(waited)} min for a reply.\n"${p.summary}"`;
      const where = config.ops.nudgeWhere;
      if (where === "customer_group") await trySend("ops", p.chat_id, `@${digits(who.phone)} please respond here.`, [digits(who.phone)]);
      else if (where === "team_group" && config.ops.teamGroupId) await trySend("ops", config.ops.teamGroupId, `${text}\n@${digits(who.phone)} please reply in the group.`, [digits(who.phone)]);
      else await trySend("ops", who.phone, `${text}\nPlease reply in the group.`);
      run("UPDATE pending SET nudged_at=? WHERE chat_id=?", t, p.chat_id);
    } else if (!p.escalated_at && waited >= config.ops.escalateAfterMinutes * 60 && who !== config.owner) {
      await trySend("ops", config.owner.phone, `🚨 *${p.name}*: still no reply after ${mins(waited)} min (${who.name} was reminded).\n"${p.summary}"`);
      run("UPDATE pending SET escalated_at=? WHERE chat_id=?", t, p.chat_id);
    }
  }
}

/** Remind assignees about open tasks at their due time, then daily; tell the owner on the second reminder. */
export async function checkTasks() {
  if (!inWorkingHours()) return;
  const t = now();
  for (const task of all("SELECT * FROM tasks WHERE status<>'done' AND next_ping_ts<=?", t)) {
    const m = memberByName(task.assignee);
    if (m) await trySend("ops", m.phone, `🔔 Reminder, task #${task.id}${task.status === "blocked" ? " (blocked)" : ""}:\n${task.text}\n\nReply here with an update.`);
    run("UPDATE tasks SET pings=pings+1, next_ping_ts=? WHERE id=?", t + 24 * 3600, task.id);
    if (task.pings + 1 === 2) await trySend("ops", config.owner.phone, `⚠️ Task #${task.id} for ${task.assignee} is still ${task.status} after two reminders:\n${task.text}`);
  }
}

/** Once a day, send the owner a summary of all customer groups and open items. */
export async function dailyDigest(force = false) {
  const today = localDate();
  if (!force && (kvGet("digest_date") === today || localTime() < config.ops.digestTime)) return;
  kvSet("digest_date", today);

  const since = now() - 24 * 3600;
  let budget = 150_000; // characters of transcript handed to the model
  const sections: string[] = [];
  for (const g of all("SELECT g.chat_id, g.name FROM groups g WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=g.chat_id AND m.ts>=?)", since)) {
    if (g.chat_id === config.ops.teamGroupId) continue;
    const text = transcript(recent("ops", g.chat_id, 60).filter((m) => m.ts >= since));
    if (text.length > budget) { sections.push(`## ${g.name}\n(activity today, not included: too much to fit)`); continue; }
    budget -= text.length;
    sections.push(`## ${g.name}\n${text}`);
  }
  const waiting = all("SELECT g.name, p.since_ts, p.summary FROM pending p JOIN groups g ON g.chat_id=p.chat_id");
  const tasks = all("SELECT * FROM tasks WHERE status<>'done'");
  if (!sections.length && !waiting.length && !tasks.length) return;

  const summary = await runAgent({
    effort: "medium",
    system: `You write the end-of-day WhatsApp summary for ${config.owner.name}, who runs a UAE business-setup consultancy. Below are the last 24 hours of messages from customer groups (TEAM = staff, CUSTOMER = client), plus open items.

Lead with what needs ${config.owner.name}'s attention: clients still waiting, unhappy clients, promises made with deadlines, payments or documents outstanding. Then one line per active group on where it stands. Skip groups where nothing notable happened. Keep it readable on a phone: WhatsApp formatting only (*bold*, "-" lists), no headings, under 250 words unless there is genuinely more that matters. State only what the messages show.`,
    turns: [{
      role: "user",
      content: `Date: ${nowText()}\n\nClients waiting for a reply right now:\n${waiting.map((w) => `- ${w.name}: ${mins(now() - w.since_ts)} min${w.summary ? ` (${w.summary})` : ""}`).join("\n") || "none"}\n\nOpen tasks:\n${tasks.map(describeTask).join("\n") || "none"}\n\nGroup activity:\n\n${sections.join("\n\n") || "none"}`,
    }],
  });
  if (summary) await trySend("ops", config.owner.phone, `📋 *Daily summary*\n${summary}`);
}
