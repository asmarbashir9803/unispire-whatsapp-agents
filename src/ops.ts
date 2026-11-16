/**
 * Operations agent: sits in every customer group on the "ops" WhatsApp number.
 * - Reads all group messages and tracks whether the client is waiting for a team reply.
 * - Chases the team (never the customer) when a reply is late, then escalates to the owner.
 * - Takes instructions from the owner by private message and follows up on tasks with the team.
 */
import { z } from "zod";
import {
  config, digits, env, inWorkingHours, isMonitoredGroup, isOwner, localDate, localTime, memberById, memberByName, now, nowText, workStartToday,
  type Member,
} from "./config.ts";
import { all, createTask, findGroup, get, kvGet, kvSet, recent, run, saveMessage, transcript } from "./db.ts";
import { runAgent, tool, triage, type ToolSpec, type Turn } from "./llm.ts";
import { contactLead } from "./sales.ts";
import { trySend, type Incoming } from "./whapi.ts";

const mins = (s: number) => Math.max(1, Math.round(s / 60));

/** Messages to staff are signed, so nobody mistakes an automated message for the owner typing (the agent may run on the owner's own number). */
const signature = () => `\n\n— ${config.owner.name}'s AI assistant`;
const toStaff = (phone: string, text: string) => trySend("ops", phone, text + signature());

export async function handleOps(m: Incoming, live: boolean) {
  if (m.fromMe && m.source === "api") return; // our own sends echoed back
  const member = memberById(m.from);

  if (m.isGroup) {
    if (m.chatId !== config.ops.teamGroupId && !isMonitoredGroup(m.chatId, m.chatName)) return; // not a watched group: keep nothing
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
  // When the agent runs on the owner's own number, the owner talks to it in their "message yourself" chat.
  const selfChat = m.fromMe && digits(m.chatId) === digits(config.owner.phone);
  const who = selfChat ? config.owner : m.fromMe ? undefined : member ?? memberById(m.chatId);
  if (!who) return;
  // Staff chats with the owner's number are private unless the agent is following something up with that person.
  if (who !== config.owner && !get("SELECT 1 x FROM tasks WHERE assignee=? AND status<>'done' AND pings>=0 LIMIT 1", who.name)) return;
  const fresh = saveMessage({ id: m.id, channel: "ops", chat_id: m.chatId, sender: digits(who.phone), sender_name: who.name, role: "team", body: m.body, ts: m.ts });
  if (!fresh || !live) return;

  const owner = who === config.owner;
  const turns: Turn[] = recent("ops", m.chatId, 20).map((x) => ({ role: x.role === "bot" ? "assistant" : "user", content: x.body }));
  while (turns.length && turns[0].role === "assistant") turns.shift();
  const reply = await runAgent({
    purpose: owner ? "owner chat" : "staff chat",
    effort: owner ? "medium" : "low",
    system: owner ? ownerPrompt() : teamPrompt(who),
    turns,
    tools: owner ? ownerTools() : teamTools(who),
  });
  if (reply) await (owner ? trySend("ops", m.chatId, reply) : toStaff(m.chatId, reply));
}

// ---------- prompts ----------

const roster = () => config.team.map((t) => `- ${t.name}${t.role ? ` (${t.role})` : ""}`).join("\n");

const ownerPrompt = () => `You are the operations assistant for ${config.owner.name}, who runs a UAE business-setup consultancy. You are a WhatsApp account that is a member of every customer group. ${config.owner.name} is messaging you privately.

What you do:
- Answer questions about what is happening in customer groups, using the tools to read them. Report facts from the messages; say so when you cannot find something.
- Turn instructions into tasks for team members and message them. The system reminds assignees automatically and tells ${config.owner.name} when a task is overdue or done.
- Pass messages to team members when asked.
- Start sales conversations: when ${config.owner.name} gives you a prospect's number, use contact_client so the sales agent messages them from the separate sales number, then show ${config.owner.name} the message that went out. You can also report on leads and read their chats.

Apart from that sales tool, you never write to customers. You only talk to ${config.owner.name} and the team.

Team:
${roster()}

Write the way a capable assistant texts their boss on WhatsApp: short, plain, no headings. WhatsApp formatting only (*bold*, lists with "-"). Reply in the language ${config.owner.name} writes in. Current time: ${nowText()}.`;

const teamPrompt = (m: Member) => `You are the operations assistant for ${config.owner.name}'s UAE business-setup consultancy. You are a WhatsApp account that follows up with the team on ${config.owner.name}'s behalf. ${m.name}${m.role ? ` (${m.role})` : ""} is messaging you privately.

Help ${m.name} with their tasks: show what is open, and record updates when they say something is done or blocked (use the tools, which also inform ${config.owner.name}). If they ask for something only ${config.owner.name} can decide, say you will pass it on and use the tool to do so.

Be brief and friendly, like a colleague on WhatsApp. Reply in the language ${m.name} writes in. Current time: ${nowText()}.`;

// ---------- tools ----------

function taskMessage(t: Record<string, any>) {
  const hours = t.due_ts ? Math.max(1, Math.round((t.due_ts - now()) / 3600)) : 0;
  return `📌 Task from ${config.owner.name} (#${t.id})\n${t.text}${t.group_name ? `\nGroup: ${t.group_name}` : ""}${hours ? `\nDue in ${hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`}` : ""}\n\nReply here when it is done.`;
}

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
        send_now: z.boolean().optional().describe("Outside office hours the task message waits until the office opens. Set true only if the owner asks for it to go immediately."),
      }),
      run: async ({ assignee, text, due_in_hours, group, send_now }) => {
        const m = memberByName(assignee);
        if (!m || m === config.owner) return `No team member called "${assignee}". Team: ${config.team.map((t) => t.name).join(", ")}`;
        const g = group ? findGroup(group) : undefined;
        const id = createTask(m.name, text, due_in_hours ? now() + Math.round(due_in_hours * 3600) : null, g?.name ?? group ?? null);
        if (!send_now && !inWorkingHours()) {
          run("UPDATE tasks SET pings=-1, next_ping_ts=? WHERE id=?", now(), id); // announced by checkTasks when the office opens
          return `Task #${id} created for ${m.name}. It is outside office hours, so they will be messaged when the office opens (${config.workingHours.start}).`;
        }
        const sent = await toStaff(m.phone, taskMessage({ id, text, group_name: g?.name ?? null, due_ts: due_in_hours ? now() + Math.round(due_in_hours * 3600) : null }));
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
        return (await toStaff(m.phone, text)) ? `Sent to ${m.name}.` : `Could not send to ${m.name}.`;
      },
    }),
    tool({
      name: "contact_client",
      description: "Have the sales agent send a personalised first WhatsApp message to a prospect from the sales number, for example to confirm their enquiry was received. From then on the sales agent handles that person's replies and follow-ups, and hands over to a person when they are ready to proceed. Returns the exact message that was sent.",
      schema: z.object({
        phone: z.string().describe("Client's WhatsApp number with country code"),
        name: z.string().optional().describe("Client's name"),
        about: z.string().optional().describe("What the client enquired about and anything else known: activity, free zone or mainland, visas, where the enquiry came from"),
        instruction: z.string().optional().describe("Only if the owner wants something specific said; otherwise leave empty for the standard enquiry-received message"),
      }),
      run: (input) => contactLead(input),
    }),
    tool({
      name: "list_leads",
      description: "List the sales agent's leads with their status (active, handoff, cold, stopped), what is known about them and when they last wrote.",
      schema: z.object({}),
      run: () => all("SELECT * FROM leads ORDER BY coalesce(last_in_ts, created_ts) DESC LIMIT 100")
        .map((l) => `${l.name ?? "Unknown"} +${digits(l.chat_id)} [${l.status}] ${l.details}${l.last_in_ts ? ` | last wrote ${mins(now() - l.last_in_ts)} min ago` : " | no reply yet"}`).join("\n") || "No leads yet.",
    }),
    tool({
      name: "read_lead_chat",
      description: "Read the sales agent's conversation with one lead.",
      schema: z.object({ phone: z.string().describe("Lead's phone number") }),
      run: ({ phone }) => transcript(recent("sales", `${digits(phone)}@s.whatsapp.net`, 60)) || "No conversation stored for that number.",
    }),
    tool({
      name: "ai_usage",
      description: "Report what the agents have spent on AI: today against the daily limit, and the last 7 days broken down by what the AI was used for.",
      schema: z.object({}),
      run: () => {
        const today = all("SELECT purpose, count(*) calls, sum(cost_usd) cost FROM usage WHERE day=? GROUP BY purpose ORDER BY cost DESC", localDate());
        const week = all("SELECT day, count(*) calls, sum(cost_usd) cost FROM usage WHERE ts>=? GROUP BY day ORDER BY day DESC", now() - 7 * 86400);
        const sum = today.reduce((a, r) => a + r.cost, 0);
        return `Today: $${sum.toFixed(2)}${env.dailyBudgetUsd > 0 ? ` of $${env.dailyBudgetUsd} daily limit` : " (no limit set)"}\n${today.map((r) => `- ${r.purpose}: ${r.calls} calls, $${r.cost.toFixed(2)}`).join("\n") || "- nothing yet"}\n\nLast 7 days:\n${week.map((r) => `- ${r.day}: ${r.calls} calls, $${r.cost.toFixed(2)}`).join("\n") || "- nothing yet"}\nModel: ${env.model}. Sales auto-reply: ${kvGet("sales_auto") === "off" ? "OFF" : "ON"}.`;
      },
    }),
    tool({
      name: "set_sales_auto_reply",
      description: "Turn the sales agent's automatic replies to new form enquiries on or off. When off, new enquiries are saved as waiting leads without using AI, and the agent only starts a chat when the owner asks with contact_client. Chats already in progress continue either way.",
      schema: z.object({ on: z.boolean() }),
      run: ({ on }) => { kvSet("sales_auto", on ? "on" : "off"); return `Sales auto-reply is now ${on ? "ON: new form enquiries are answered automatically" : "OFF: new form enquiries wait until the owner asks to contact them"}.`; },
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
      else if (who === config.owner) await trySend("ops", who.phone, `${text}\nNo team member is assigned to this group.`);
      else await toStaff(who.phone, `${text}\nPlease reply in the group.`);
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
    if (task.pings < 0) { // created outside office hours: this is the first message about it
      if (m) await toStaff(m.phone, taskMessage(task));
      run("UPDATE tasks SET pings=0, next_ping_ts=? WHERE id=?", task.due_ts ?? t + 4 * 3600, task.id);
      continue;
    }
    if (m) await toStaff(m.phone, `🔔 Reminder, task #${task.id}${task.status === "blocked" ? " (blocked)" : ""}:\n${task.text}\n\nReply here with an update.`);
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
    purpose: "daily summary",
    effort: "low",
    system: `You write the end-of-day WhatsApp summary for ${config.owner.name}, who runs a UAE business-setup consultancy. Below are the last 24 hours of messages from customer groups (TEAM = staff, CUSTOMER = client), plus open items.

Lead with what needs ${config.owner.name}'s attention: clients still waiting, unhappy clients, promises made with deadlines, payments or documents outstanding. Then one line per active group on where it stands. Skip groups where nothing notable happened. Keep it readable on a phone: WhatsApp formatting only (*bold*, "-" lists), no headings, under 250 words unless there is genuinely more that matters. State only what the messages show.`,
    turns: [{
      role: "user",
      content: `Date: ${nowText()}\n\nClients waiting for a reply right now:\n${waiting.map((w) => `- ${w.name}: ${mins(now() - w.since_ts)} min${w.summary ? ` (${w.summary})` : ""}`).join("\n") || "none"}\n\nOpen tasks:\n${tasks.map(describeTask).join("\n") || "none"}\n\nGroup activity:\n\n${sections.join("\n\n") || "none"}`,
    }],
  });
  if (summary) await trySend("ops", config.owner.phone, `📋 *Daily summary*\n${summary}`);
}
