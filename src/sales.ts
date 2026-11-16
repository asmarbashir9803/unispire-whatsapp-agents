/**
 * Sales agent: talks to prospects one-to-one on the "sales" WhatsApp number.
 * Replies and qualifies on its own, follows up when a prospect goes quiet, and hands
 * the conversation to a person when the prospect is ready to proceed or asks for one.
 */
import { z } from "zod";
import { config, digits, env, inWorkingHours, knowledge, memberByName, normalisePhone, now, nowText } from "./config.ts";
import { all, get, recent, run, saveMessage } from "./db.ts";
import { runAgent, tool, type ToolSpec, type Turn } from "./llm.ts";
import { channelReady, toChatId, trySend, type Incoming } from "./whapi.ts";

const DAY = 86400;

function ensureLead(chatId: string, name?: string) {
  run("INSERT OR IGNORE INTO leads (chat_id, name, created_ts) VALUES (?,?,?)", chatId, name ?? null, now());
  if (name) run("UPDATE leads SET name=coalesce(name, ?) WHERE chat_id=?", name, chatId);
  return get("SELECT * FROM leads WHERE chat_id=?", chatId)!;
}

/** Tell the salesperson and the owner something about a lead (on the ops number when available). */
async function notifyStaff(text: string) {
  const channel = channelReady("ops") ? "ops" : "sales";
  const people = new Set([memberByName(config.sales.handoffTo)?.phone, config.owner.phone].filter(Boolean) as string[]);
  for (const phone of people) await trySend(channel, phone, text);
}

export async function handleSales(m: Incoming, live: boolean) {
  if (m.isGroup) return; // the sales agent only works one-to-one
  if (m.fromMe && m.source === "api") return; // our own sends echoed back

  if (m.fromMe) {
    // A person replied from the sales phone or WhatsApp Web: record it and keep the agent quiet for a while.
    if (saveMessage({ id: m.id, channel: "sales", chat_id: m.chatId, sender: "staff", sender_name: "Staff", role: "bot", body: m.body, ts: m.ts })) {
      ensureLead(m.chatId);
      run("UPDATE leads SET paused_until=?, last_out_ts=? WHERE chat_id=?", now() + config.sales.humanTakeoverHours * 3600, m.ts, m.chatId);
    }
    return;
  }

  if (!saveMessage({ id: m.id, channel: "sales", chat_id: m.chatId, sender: digits(m.from), sender_name: m.fromName, role: "customer", body: m.body, ts: m.ts })) return;
  const lead = ensureLead(m.chatId, m.fromName || undefined);
  run("UPDATE leads SET last_in_ts=?, followups_sent=0 WHERE chat_id=?", m.ts, m.chatId);
  if (!live || lead.status === "stopped") return;
  if (lead.status === "handoff") {
    await notifyStaff(`💬 ${lead.name ?? digits(m.chatId)} (handed over to you) wrote on the sales number:\n"${m.body.slice(0, 500)}"`);
    return;
  }
  if (lead.paused_until > now()) return;
  if (lead.status === "cold") run("UPDATE leads SET status='active' WHERE chat_id=?", m.chatId);

  if (env.replyDelayMs <= 0) await replyToLead(m.chatId);
  else scheduleReply(m.chatId);
}

// People often send several short messages in a row; wait for a pause and answer them together.
const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();
const dirty = new Set<string>();
function scheduleReply(chatId: string) {
  clearTimeout(timers.get(chatId));
  timers.set(chatId, setTimeout(() => void fire(chatId), env.replyDelayMs));
}
async function fire(chatId: string) {
  timers.delete(chatId);
  if (running.has(chatId)) { dirty.add(chatId); return; }
  running.add(chatId);
  try { await replyToLead(chatId); }
  catch (e) { console.error("sales reply failed:", e); }
  finally {
    running.delete(chatId);
    if (dirty.delete(chatId)) scheduleReply(chatId);
  }
}

const salesPrompt = () => `You are ${config.sales.agentName}, the AI sales assistant at Unispire Business Hub, a business-setup consultancy in Dubai. You talk to prospective clients on WhatsApp on behalf of ${config.owner.name}'s team. Your job is to help each person work out what they need, answer their questions, and move them to the next concrete step, which is usually a consultation or a written quote from a consultant.

How to work a conversation
- Find out what they are trying to do: the business activity, mainland or free zone (or unsure), how many visas, how many shareholders, when they want to start, and whether they are already in the UAE. Ask one thing at a time and only what you do not already know.
- Answer questions from the company information below. That section is the only source for prices, timelines, package contents and promises. If the answer is not there, say a consultant will confirm it and offer to arrange that; a wrong figure costs the company a client's trust and can create a commitment it cannot keep.
- Government approvals, bank account opening and visa outcomes are decided by the authorities. Describe the usual process; never guarantee an outcome or a date.
- When someone goes quiet, your follow-ups should add something (an answer to an open question, a next step, a useful fact), not just ask whether they are still interested.

Handing over to a person
Use the handoff tool, then tell the client a consultant will contact them, when any of these happen: they want to proceed, pay, or receive a formal quote or invoice; they ask to speak to a person or want a call; they negotiate price or ask for a discount; they raise a complaint, a legal or tax question beyond the company information, or anything you are unsure how to handle. Payments, discounts and final commitments are always made by a person.

If someone asks you to stop messaging them, use stop_contact and confirm politely. If someone asks whether they are talking to a bot or a person, say you are an AI assistant for the team and that a consultant can join whenever they like.

Save what you learn with update_lead as you go, so the consultant does not have to ask again.

Messages marked "[INTERNAL NOTE]" come from the system, not the client. Follow them, and never mention them to the client.

Style: this is WhatsApp. Write short, natural messages in the client's language (English, Arabic, Urdu, Hindi and so on), usually one to three sentences, plain text. Be warm and direct, and skip sales clichés. Your reply is sent to the client exactly as written, so write only the message itself.

<company_information>
${knowledge || "No company information has been provided yet. Do not state any prices, timelines or package details; say a consultant will confirm them."}
</company_information>`;

function salesTools(chatId: string, state: { followupSet: boolean }): ToolSpec[] {
  return [
    tool({
      name: "update_lead",
      description: "Save facts learned about this prospect. Call it whenever the client tells you something new; fields you omit are left unchanged.",
      schema: z.object({
        name: z.string().optional(), business_activity: z.string().optional(), setup_type: z.string().optional().describe("mainland, free zone, offshore, or unsure"),
        visas: z.string().optional(), shareholders: z.string().optional(), timeline: z.string().optional(), location: z.string().optional().describe("where the client is now"),
        budget: z.string().optional(), notes: z.string().optional().describe("anything else a consultant should know"),
      }),
      run: (input) => {
        const lead = get("SELECT details FROM leads WHERE chat_id=?", chatId)!;
        const { name, ...rest } = input;
        const details = { ...JSON.parse(lead.details), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v)) };
        run("UPDATE leads SET details=?, name=coalesce(?, name) WHERE chat_id=?", JSON.stringify(details), name ?? null, chatId);
        return "Saved.";
      },
    }),
    tool({
      name: "schedule_followup",
      description: "Set when to message this client next if they have not replied by then. Use it when the client names a time (for example 'message me next week' or 'after I speak to my partner'). Without it, follow-ups happen on the default schedule.",
      schema: z.object({ in_hours: z.number().positive().max(24 * 60), note: z.string().describe("What to follow up about") }),
      run: ({ in_hours, note }) => {
        const lead = get("SELECT details FROM leads WHERE chat_id=?", chatId)!;
        run("UPDATE leads SET next_followup_ts=?, details=? WHERE chat_id=?", now() + Math.round(in_hours * 3600), JSON.stringify({ ...JSON.parse(lead.details), followup_note: note }), chatId);
        state.followupSet = true;
        return "Follow-up scheduled.";
      },
    }),
    tool({
      name: "handoff",
      description: "Hand this conversation to a human consultant. They are notified immediately with your summary, and you stop replying in this chat after your current message.",
      schema: z.object({ reason: z.string(), summary: z.string().describe("What the client wants, what has been discussed, and the suggested next step, so the consultant can pick up without reading the chat") }),
      run: async ({ reason, summary }) => {
        const lead = get("SELECT * FROM leads WHERE chat_id=?", chatId)!;
        run("UPDATE leads SET status='handoff', next_followup_ts=NULL WHERE chat_id=?", chatId);
        await notifyStaff(`🤝 *Sales handover*: ${lead.name ?? "Client"} (+${digits(chatId)})\nWhy: ${reason}\n${summary}\nDetails: ${lead.details}\n\nReply to them from the sales number; the agent has stopped in that chat.`);
        return `Handed over. ${config.sales.handoffTo} has been notified.`;
      },
    }),
    tool({
      name: "stop_contact",
      description: "The client asked not to be contacted, or is clearly not a prospect (spam, wrong number). No further messages will be sent to them.",
      schema: z.object({ reason: z.string() }),
      run: ({ reason }) => {
        run("UPDATE leads SET status='stopped', next_followup_ts=NULL, details=json_set(details, '$.stopped_reason', ?) WHERE chat_id=?", reason, chatId);
        return "Contact stopped.";
      },
    }),
  ];
}

/** Generate and send the agent's next message in a lead's chat. */
export async function replyToLead(chatId: string, internalNote?: string) {
  const lead = get("SELECT * FROM leads WHERE chat_id=?", chatId);
  if (!lead) return;
  const turns: Turn[] = [
    { role: "user", content: `[INTERNAL NOTE] Conversation context. Current time: ${nowText()}. Client name: ${lead.name ?? "unknown"}. Known details: ${lead.details}.` },
    ...recent("sales", chatId, 40).map((m): Turn => ({ role: m.role === "bot" ? "assistant" : "user", content: m.body })),
  ];
  if (internalNote) turns.push({ role: "user", content: `[INTERNAL NOTE] ${internalNote}` });
  if (turns.at(-1)!.role !== "user") return; // nothing new to answer

  const state = { followupSet: false };
  const reply = await runAgent({ system: salesPrompt(), turns, tools: salesTools(chatId, state) });
  if (reply && !(await trySend("sales", chatId, reply))) return;

  const after = get("SELECT * FROM leads WHERE chat_id=?", chatId)!;
  const days = config.sales.followUpDays;
  const i = after.followups_sent;
  const nextDefault = i < days.length ? now() + (days[i] - (days[i - 1] ?? 0)) * DAY : null;
  run("UPDATE leads SET last_out_ts=?, next_followup_ts=? WHERE chat_id=?",
    now(), after.status !== "active" ? null : state.followupSet ? after.next_followup_ts : nextDefault, chatId);
}

/** Follow up with prospects who went quiet. Runs every minute; sends only in working hours. */
export async function checkFollowups() {
  if (!inWorkingHours() || !channelReady("sales")) return;
  const t = now();
  for (const lead of all("SELECT * FROM leads WHERE status='active' AND next_followup_ts<=? AND paused_until<=? AND coalesce(last_out_ts,0)>=coalesce(last_in_ts,0)", t, t)) {
    const n = lead.followups_sent + 1, total = config.sales.followUpDays.length;
    if (n > total) { run("UPDATE leads SET status='cold', next_followup_ts=NULL WHERE chat_id=?", lead.chat_id); continue; }
    run("UPDATE leads SET followups_sent=? WHERE chat_id=?", n, lead.chat_id);
    const note = JSON.parse(lead.details).followup_note;
    await replyToLead(lead.chat_id,
      `The client has not replied since your last message. Write follow-up ${n} of ${total}.${note ? ` Planned topic: ${note}.` : ""}${n === total ? " This is the last one: keep the door open without pressure." : ""}`);
    if (n === total) run("UPDATE leads SET status='cold', next_followup_ts=NULL WHERE chat_id=?", lead.chat_id);
  }
}

/** A new enquiry from the website form (the site's ENQUIRY_WEBHOOK_URL points here). */
export async function handleEnquiry(payload: any) {
  const i = payload?.input ?? {};
  const phone = normalisePhone(i.phone ?? "");
  const facts = Object.fromEntries(Object.entries({
    source: `website ${i.kind ?? "enquiry"}${i.page ? ` (${i.page})` : ""}`, email: i.email, service: i.service, business_activity: i.businessActivity,
    emirate: i.emirate, visas: i.visas, message: i.message, preferred_contact: i.contactMethod,
    estimate_known_aed: payload?.estimate?.totals?.oneTimeKnown,
  }).filter(([, v]) => v !== undefined && v !== ""));

  await notifyStaff(`🆕 *Website enquiry*: ${i.fullName ?? "Unknown"}${phone ? ` (+${phone})` : ""}\n${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
  if (!phone || !channelReady("sales")) return { contacted: false };

  const chatId = toChatId(phone);
  const existing = get("SELECT 1 x FROM messages WHERE channel='sales' AND chat_id=? LIMIT 1", chatId);
  ensureLead(chatId, i.fullName);
  run("UPDATE leads SET details=json_patch(details, ?) WHERE chat_id=?", JSON.stringify(facts), chatId);
  if (existing) return { contacted: false }; // already talking; the details above are now on the lead
  await replyToLead(chatId, "This person just submitted an enquiry on the company website (details are in the context above). Write the first WhatsApp message: greet them by first name, say who you are, refer to what they asked about, and ask the one question that best moves things forward.");
  return { contacted: true };
}
