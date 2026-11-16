/**
 * Sales agent: talks to prospects one-to-one on the "sales" WhatsApp number.
 * Replies and qualifies on its own, follows up when a prospect goes quiet, and hands
 * the conversation to a person when the prospect is ready to proceed or asks for one.
 */
import { z } from "zod";
import { config, digits, env, inWorkingHours, knowledge, memberByName, normalisePhone, now, nowText } from "./config.ts";
import { all, get, kvGet, recent, run, saveMessage } from "./db.ts";
import { runAgent, tool, type ToolSpec, type Turn } from "./llm.ts";
import { addLabel, channelReady, toChatId, trySend, type Incoming } from "./whapi.ts";

const DAY = 86400;

const FORM_KEYS: [RegExp, string][] = [
  [/first name/i, "first_name"], [/last name/i, "last_name"], [/full name/i, "name"], [/whatsapp/i, "whatsapp"], [/phone|mobile/i, "phone"],
  [/e-?mail/i, "email"], [/visa/i, "visas"], [/business activity/i, "business_activity"], [/type of business setup|business setup/i, "setup_type"],
  [/planning to start|when are you/i, "timeline"], [/nationality/i, "nationality"],
];

/**
 * Recognise the message a person sends after filling in the ad lead form: an intro line followed by
 * "Question: answer" lines. Returns the answers, or null if this is not a form message.
 */
export function parseLeadForm(body: string): { name?: string; details: Record<string, string> } | null {
  const details: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(.{3,90}?)\??\s*:\s*(\S.*)$/);
    if (!m) continue;
    const key = FORM_KEYS.find(([re]) => re.test(m[1]))?.[1];
    if (key && !details[key]) details[key] = m[2].trim();
  }
  if (Object.keys(details).length < 3) return null;
  const name = details.name ?? [details.first_name, details.last_name].filter(Boolean).join(" ");
  delete details.first_name; delete details.last_name; delete details.name;
  return { name: name || undefined, details: { source: "lead form", ...details } };
}

/** A phone number to show staff: chat ids are sometimes private WhatsApp ids rather than numbers. */
function leadPhone(lead: Record<string, any>) {
  const d = JSON.parse(lead.details ?? "{}");
  return d.whatsapp ?? d.phone ?? (String(lead.chat_id).endsWith("@lid") ? "number not known" : `+${digits(lead.chat_id)}`);
}

/** Lead details as short readable lines for staff alerts. */
function fmtDetails(json: string) {
  const d = JSON.parse(json ?? "{}");
  return Object.entries(d).filter(([k, v]) => v !== "" && v != null && !["interested", "followup_note", "notes"].includes(k))
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`).join("\n") || "- nothing yet";
}

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

  const known = get("SELECT 1 x FROM leads WHERE chat_id=?", m.chatId);
  if (!known && (config.sales.replyTo ?? "leads") === "leads") {
    // Not one of the agent's leads. Take it on only if this is a lead-form message; otherwise leave the chat alone and keep nothing.
    const form = m.fromMe ? null : parseLeadForm(m.body);
    if (!form) return;
    ensureLead(m.chatId, form.name || m.fromName || undefined);
    run("UPDATE leads SET details=json_patch(details, ?) WHERE chat_id=?", JSON.stringify(form.details), m.chatId);
    // With auto-reply off the enquiry just waits (no AI used) until the owner asks to contact this person.
    if (kvGet("sales_auto") === "off") run("UPDATE leads SET status='waiting' WHERE chat_id=?", m.chatId);
  }

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
  if (!live || lead.status === "stopped" || lead.status === "waiting") return;
  if (lead.status === "handoff") {
    await notifyStaff(`💬 ${lead.name ?? leadPhone(lead)} (handed over to you) wrote on the sales number:\n"${m.body.slice(0, 500)}"`);
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
- Most people reach you after filling in the company's enquiry form; their first message then lists their answers. Open by telling them the team received their enquiry to start their business setup in the UAE, and use what the form already says instead of asking again.
- The team prices each setup from four facts, so your first aim is to collect whichever of these are missing or vague: the client's nationality, whether they need UAE visas and how many, which business activity they will run (a form answer of "Other" or a broad word like "Trading" needs one follow-up to pin down), and free zone or mainland. Tell them briefly that these let the team prepare an accurate price. Ask one thing at a time.
- Filling in the form is not yet interest. When the client answers your first message positively or starts giving you the details you asked for, call mark_interested. Someone who says they are not interested, was only browsing, or does not reply is never marked. Once you have nationality, visas, activity and setup type, use handoff with a summary so a consultant can send the pricing, and tell the client the pricing is being prepared.
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
        name: z.string().optional(), nationality: z.string().optional(), business_activity: z.string().optional(), setup_type: z.string().optional().describe("mainland, free zone, offshore, or unsure"),
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
      name: "mark_interested",
      description: "Put this client on the company's Interested Customers list in WhatsApp and tell the team. Call it once, when the client replies to you and shows real interest: a positive reply, answering your questions, or asking about price or next steps. Do not call it for the form message alone, or for people who say they are not interested or who wrote by mistake.",
      schema: z.object({ why: z.string().describe("One line: what the client said that shows interest") }),
      run: async ({ why }) => {
        const lead = get("SELECT * FROM leads WHERE chat_id=?", chatId)!;
        if (JSON.parse(lead.details).interested) return "Already on the interested list.";
        run("UPDATE leads SET details=json_set(details, '$.interested', json('true')) WHERE chat_id=?", chatId);
        const label = config.sales.interestedLabel ?? "Interested Customers";
        const labelled = await addLabel("sales", chatId, label);
        await notifyStaff(`⭐ *Interested client*: ${lead.name ?? "Client"} (${leadPhone(lead)})\n${why}\n${fmtDetails(lead.details)}${labelled ? "" : `\n(Could not add the "${label}" label in WhatsApp; please add it by hand.)`}`);
        return labelled ? "Added to the interested list; the team has been told." : "The team has been told, but the WhatsApp label could not be added.";
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
        await notifyStaff(`🤝 *Sales handover*: ${lead.name ?? "Client"} (${leadPhone(lead)})\nWhy: ${reason}\n${summary}\n\nReply to them from the sales number; the agent has stopped in that chat.`);
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
  const reply = await runAgent({ purpose: "sales chat", effort: "low", system: salesPrompt(), turns, tools: salesTools(chatId, state) });
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

/** Start a conversation with a prospect on the owner's instruction. */
export async function contactLead(input: { phone: string; name?: string; about?: string; instruction?: string }) {
  const phone = normalisePhone(input.phone);
  if (!phone) return `"${input.phone}" is not a valid phone number. Include the country code.`;
  if (!channelReady("sales")) return "The sales WhatsApp number is not connected.";
  // A form enquiry that is waiting may sit under WhatsApp's private chat id; find it by the number given in the form.
  const waiting = all("SELECT chat_id, details FROM leads WHERE status='waiting'").find((l) => {
    const d = JSON.parse(l.details);
    return [d.whatsapp, d.phone].some((x) => x && normalisePhone(x) === phone);
  });
  const chatId = waiting?.chat_id ?? toChatId(phone);
  const lead = ensureLead(chatId, input.name);
  if (lead.status === "stopped") return `+${phone} asked not to be contacted, so nothing was sent.`;
  if (input.about) run("UPDATE leads SET details=json_patch(details, ?) WHERE chat_id=?", JSON.stringify({ source: "added by owner", enquiry: input.about }), chatId);
  if (lead.status !== "active") run("UPDATE leads SET status='active', paused_until=0 WHERE chat_id=?", chatId);
  const before = get("SELECT count(*) c FROM messages WHERE channel='sales' AND chat_id=? AND role='bot'", chatId)!.c;
  await replyToLead(chatId,
    `${config.owner.name} asked you to message this person now. ${input.instruction ?? "They sent an enquiry about starting a business in the UAE. Write the first WhatsApp message: greet them by first name if known, say who you are, confirm the enquiry was received, refer to what they asked about, and ask the one question that best moves things forward."}`);
  const after = get("SELECT count(*) c FROM messages WHERE channel='sales' AND chat_id=? AND role='bot'", chatId)!.c;
  if (after === before) return `Could not send a message to +${phone}.`;
  const last = recent("sales", chatId, 1)[0];
  return `Sent to +${phone} from the sales number:\n"${last.body}"\nReplies from this person are now handled by the sales agent.`;
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
