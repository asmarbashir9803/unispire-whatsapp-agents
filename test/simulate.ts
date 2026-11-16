/**
 * Replays fake WhatsApp traffic through both agents. Nothing is sent (DRY_RUN) and Claude is
 * stubbed (LLM_FAKE), so this checks the plumbing and rules, not the quality of the wording.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-agents-")), "test.sqlite");
Object.assign(process.env, {
  CONFIG_PATH: path.join(here, "config.test.json"), DB_PATH: dbPath, DRY_RUN: "1", LLM_FAKE: "1",
  REPLY_DELAY_MS: "0", WEBHOOK_SECRET: "hook-secret", ENQUIRY_WEBHOOK_SECRET: "enq-secret", LLM_FAKE_REPLY: "FAKE_REPLY",
});

const { now } = await import("../src/config.ts");
const { get, all, run } = await import("../src/db.ts");
const { outbox } = await import("../src/whapi.ts");
const ops = await import("../src/ops.ts");
const sales = await import("../src/sales.ts");
const { server, enqueue } = await import("../src/server.ts");

let failed = 0, n = 0;
function check(name: string, ok: unknown) {
  n++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
const sent = (to: string, re: RegExp) => outbox.some((o) => o.to.startsWith(to) && re.test(o.body));
let seq = 0;
const msg = (o: Partial<{ chatId: string; chatName: string; from: string; fromName: string; fromMe: boolean; source: string; body: string; ago: number }>) => ({
  id: `t${++seq}`, chatId: o.chatId ?? "", chatName: o.chatName ?? "", from: o.from ?? "", fromName: o.fromName ?? "",
  fromMe: o.fromMe ?? false, source: o.source ?? "mobile", body: o.body ?? "", ts: now() - (o.ago ?? 0), isGroup: (o.chatId ?? "").endsWith("@g.us"),
});
const OWNER = "971500000001", ALI = "971500000002", SANA = "971500000003";
const G1 = "120363000000000001@g.us", G2 = "120363000000000002@g.us";
const tools = (list: any[], name: string) => list.find((t) => t.name === name)!;

// ---- group monitor ----
await enqueue("ops", msg({ chatId: G1, chatName: "Acme LLC setup", from: "447700900001", fromName: "John", body: "Can you send me the invoice please?", ago: 120 }));
check("client message opens a waiting thread", get("SELECT 1 x FROM pending WHERE chat_id=?", G1));
await enqueue("ops", msg({ chatId: G1, chatName: "Acme LLC setup", from: ALI, body: "Sending it now", ago: 60 }));
check("team reply closes it", !get("SELECT 1 x FROM pending WHERE chat_id=?", G1));

await enqueue("ops", msg({ chatId: G1, chatName: "Acme LLC setup", from: "447700900001", fromName: "John", body: "Any update on my visa?", ago: 30 }));
await ops.checkPending();
check("late reply: responsible team member is nudged privately", sent(ALI, /Acme LLC setup.*client waiting/s));
check("agent never writes in the customer group", !outbox.some((o) => o.to === G1));
check("owner not alerted on first nudge", !sent(OWNER, /still no reply/));
await ops.checkPending();
check("still unanswered: escalated to owner", sent(OWNER, /Acme LLC setup.*still no reply/s));
const before = outbox.length;
await ops.checkPending();
check("no repeat nudges", outbox.length === before);

await enqueue("ops", msg({ chatId: G2, chatName: "Beta FZ-LLC", from: "447700900002", fromName: "Mary", body: "ok thanks", ago: 30 }));
await ops.checkPending();
check("'ok thanks' needs no reply: thread dropped, nobody nudged", !get("SELECT 1 x FROM pending WHERE chat_id=?", G2) && !sent(ALI, /Beta FZ-LLC/));

await enqueue("ops", msg({ chatId: G2, chatName: "Beta FZ-LLC", from: "447700900002", fromName: "Mary", body: "Where is my licence?", ago: 30 }));
await enqueue("ops", msg({ chatId: G2, chatName: "Beta FZ-LLC", fromMe: true, source: "mobile", from: "971500000009", body: "Ready tomorrow", ago: 10 }));
check("reply typed on the ops phone itself counts as a team reply", !get("SELECT 1 x FROM pending WHERE chat_id=?", G2));

// ---- owner instructions and tasks ----
const ot = ops.ownerTools();
const created = await tools(ot, "create_task").run({ assignee: "ali", text: "Send trade licence draft to Acme", due_in_hours: 24, group: "acme" });
check("owner task is created and sent to the assignee", /Task #1 created for Ali/.test(created) && sent(ALI, /Task from Boss \(#1\).*trade licence.*Acme LLC setup/s));
check("read_group finds a group by partial name", /Any update on my visa/.test(await tools(ot, "read_group").run({ group: "acme", limit: 40 })));
check("open_items lists waiting client and task", /Acme LLC setup.*#1 \[open\] Ali/s.test(await tools(ot, "open_items").run({})));
run("UPDATE tasks SET next_ping_ts=? WHERE id=1", now() - 1);
await ops.checkTasks();
check("due task: assignee reminded", sent(ALI, /Reminder, task #1/));
const tt = ops.teamTools({ name: "Ali", phone: ALI });
await tools(tt, "update_my_task").run({ id: 1, status: "done", note: "Sent by email" });
check("team marks task done: owner informed", get("SELECT status FROM tasks WHERE id=1")?.status === "done" && sent(OWNER, /Ali: task #1 done.*Sent by email/s));
check("team member cannot touch someone else's task", /not one of/.test(await tools(ops.teamTools({ name: "Sana", phone: SANA }), "update_my_task").run({ id: 1, status: "done" })));

check("messages to staff are signed as the assistant", outbox.filter((o) => o.to.startsWith(ALI)).every((o) => /Boss's AI assistant$/.test(o.body)));
const b8 = outbox.length;
await enqueue("ops", msg({ chatId: `${SANA}@s.whatsapp.net`, from: SANA, body: "boss are you coming to the office?" }));
check("staff chat with no open follow-up is left alone and not stored", outbox.length === b8 && !get("SELECT 1 x FROM messages WHERE body LIKE 'boss are you%'"));
await tools(ot, "create_task").run({ assignee: "Sana", text: "Confirm salary is processed", send_now: true });
await enqueue("ops", msg({ chatId: `${SANA}@s.whatsapp.net`, from: SANA, body: "yes processed today" }));
check("staff reply during an open follow-up is answered", outbox.at(-1)!.to.startsWith(SANA) && /FAKE_REPLY/.test(outbox.at(-1)!.body));
await enqueue("ops", msg({ chatId: `${OWNER}@s.whatsapp.net`, from: OWNER, body: "what is open today?" }));
check("owner private message gets an answer", sent(OWNER, /FAKE_REPLY/));
const b2 = outbox.length;
await enqueue("ops", msg({ chatId: "447700900009@s.whatsapp.net", from: "447700900009", body: "hello who is this" }));
check("strangers messaging the ops number are ignored", outbox.length === b2);
const b7 = outbox.length;
await enqueue("ops", msg({ chatId: `${OWNER}@s.whatsapp.net`, from: OWNER, fromMe: true, source: "mobile", body: "who is waiting?" }));
check("owner can command the agent from their own 'message yourself' chat", outbox.length === b7 + 1 && outbox.at(-1)!.to.startsWith(OWNER));
const { config: cfg } = await import("../src/config.ts");
const days = cfg.workingHours.days; cfg.workingHours.days = [];
const b9 = outbox.length;
const queued = await tools(ot, "create_task").run({ assignee: "Ali", text: "Night task" });
check("task created outside office hours is held, not sent", /when the office opens/.test(queued) && outbox.length === b9);
cfg.workingHours.days = days;
await ops.checkTasks();
check("held task is sent when the office opens", sent(ALI, /Task from Boss \(#\d+\)\nNight task/) && get("SELECT pings FROM tasks WHERE text='Night task'")?.pings === 0);
cfg.ops.monitorGroups = ["Acme", G2];
await enqueue("ops", msg({ chatId: "120363000000000077@g.us", chatName: "La familia", from: "447700900077", body: "dinner at 8?" }));
check("groups outside the watch list are not stored or tracked", !get("SELECT 1 x FROM messages WHERE chat_id='120363000000000077@g.us'") && !get("SELECT 1 x FROM pending WHERE chat_id='120363000000000077@g.us'"));
await enqueue("ops", msg({ chatId: G1, chatName: "Acme LLC setup", from: ALI, body: "On it" }));
check("watched group (matched by name) is still stored", get("SELECT 1 x FROM messages WHERE body='On it'"));
cfg.ops.monitorGroups = "all";
await ops.dailyDigest(true);
check("daily summary sent to owner", sent(OWNER, /Daily summary/));

// ---- sales agent ----
const L1 = "447700900101@s.whatsapp.net";
await enqueue("sales", msg({ chatId: L1, from: "447700900101", fromName: "Omar", body: "Hi, how much is a free zone licence?" }));
check("prospect gets a reply on the sales number", outbox.some((o) => o.channel === "sales" && o.to === L1));
const lead1 = get("SELECT * FROM leads WHERE chat_id=?", L1)!;
check("lead recorded with a follow-up one day out", lead1.status === "active" && Math.abs(lead1.next_followup_ts - now() - 86400) < 5);

run("UPDATE leads SET next_followup_ts=? WHERE chat_id=?", now() - 1, L1);
const b3 = outbox.length;
await sales.checkFollowups();
check("quiet prospect gets follow-up 1", outbox.length === b3 + 1 && get("SELECT followups_sent f FROM leads WHERE chat_id=?", L1)?.f === 1);
await sales.checkFollowups();
check("no second follow-up before it is due", outbox.length === b3 + 1);

await enqueue("sales", msg({ chatId: L1, fromMe: true, source: "mobile", from: "971500000010", body: "Hi Omar, Sana here, calling you now" }));
const b4 = outbox.length;
await enqueue("sales", msg({ chatId: L1, from: "447700900101", fromName: "Omar", body: "great, thanks" }));
check("after a person replies from the sales phone, the agent stays quiet", outbox.length === b4);

const L2 = "447700900102@s.whatsapp.net";
await enqueue("sales", msg({ chatId: L2, from: "447700900102", fromName: "Lena", body: "I want to proceed, send me the invoice" }));
const st = (sales as any);
await enqueue("sales", msg({ chatId: "120363000000000009@g.us", from: "447700900102", body: "group chatter" }));
check("sales number ignores group messages", !get("SELECT 1 x FROM messages WHERE chat_id='120363000000000009@g.us'"));
run("UPDATE leads SET status='handoff' WHERE chat_id=?", L2);
const b5 = outbox.length;
await enqueue("sales", msg({ chatId: L2, from: "447700900102", fromName: "Lena", body: "hello?" }));
check("handed-over lead: agent silent, salesperson and owner told", !outbox.slice(b5).some((o) => o.to === L2) && sent(SANA, /Lena.*hello\?/s) && sent(OWNER, /Lena.*hello\?/s));
run("UPDATE leads SET status='stopped' WHERE chat_id=?", L1);
const b6 = outbox.length;
await enqueue("sales", msg({ chatId: L1, from: "447700900101", body: "?" }));
check("stopped lead is never messaged", outbox.length === b6);

// ---- leads-only mode and owner-started chats ----
cfg.sales.replyTo = "leads";
const b10 = outbox.length;
await enqueue("sales", msg({ chatId: "447700900555@s.whatsapp.net", from: "447700900555", fromName: "Old client", body: "hi, about my renewal" }));
check("leads-only: existing chats on the sales number are left alone and not stored", outbox.length === b10 && !get("SELECT 1 x FROM messages WHERE chat_id='447700900555@s.whatsapp.net'") && !get("SELECT 1 x FROM leads WHERE chat_id='447700900555@s.whatsapp.net'"));
const started = await tools(ops.ownerTools(), "contact_client").run({ phone: "+971 55 123 4567", name: "Hassan", about: "Free zone licence, 2 visas" });
check("owner can start a client chat: message goes from the sales number", /Sent to \+971551234567/.test(started) && outbox.at(-1)!.channel === "sales" && outbox.at(-1)!.to === "971551234567@s.whatsapp.net");
await enqueue("sales", msg({ chatId: "971551234567@s.whatsapp.net", from: "971551234567", fromName: "Hassan", body: "Yes, I need 2 visas" }));
check("leads-only: a contacted client's reply is answered", outbox.at(-1)!.to === "971551234567@s.whatsapp.net" && outbox.at(-1)!.channel === "sales");
check("invalid number is refused", /not a valid phone/.test(await tools(ops.ownerTools(), "contact_client").run({ phone: "12" })));
check("list_leads shows the new lead", /Hassan \+971551234567 \[active\]/.test(await tools(ops.ownerTools(), "list_leads").run({})));
const FORM = "Hello! I filled out your form and would like to know more about your business.\n\nEmail: b@example.com\nPhone number: +971500001111\nFirst name: Bashir\nLast name: Ahmed\nWhatsApp number: +971500001111\nWhen are you planning to start your UAE business?: Immediately\nWhat type of business setup are you looking for?: Free Zone Company\nHow many UAE visas do you require?: 1 Visa\nWhich business activity are you planning to start?: Trading";
const LID = "198251529695401@lid";
await enqueue("sales", msg({ chatId: LID, from: LID, fromName: "Bashir Ahmed", body: FORM }));
const fl = get("SELECT * FROM leads WHERE chat_id=?", LID);
const fd = JSON.parse(fl?.details ?? "{}");
check("lead-form message starts a chat automatically, even in leads-only mode", outbox.at(-1)!.to === LID && outbox.at(-1)!.channel === "sales");
check("form answers are saved on the lead", fl?.name === "Bashir Ahmed" && fd.visas === "1 Visa" && fd.setup_type === "Free Zone Company" && fd.business_activity === "Trading" && fd.timeline === "Immediately" && fd.whatsapp === "+971500001111");
const AR = "مرحبًا! لقد قمتُ بملء النموذج الخاص بك\n\nHow many UAE visas do you require?: 1 Visa\nWhich business activity are you planning to start?: Other\nPhone number: +971500002222\nFirst name: Mohamed";
check("form is recognised when the intro is in Arabic", sales.parseLeadForm(AR)?.details.business_activity === "Other");
check("ordinary messages are not mistaken for a form", sales.parseLeadForm("Hi, my name: Ali. Call me") === null && sales.parseLeadForm("Hello Good Afternoon") === null);
await tools(ops.ownerTools(), "set_sales_auto_reply").run({ on: false });
const L3 = "111122223333@lid", b11 = outbox.length;
await enqueue("sales", msg({ chatId: L3, from: L3, fromName: "Wait Person", body: FORM.replace(/\+971500001111/g, "+971500003333") }));
check("auto-reply off: a form enquiry is saved as waiting and not answered", outbox.length === b11 && get("SELECT status FROM leads WHERE chat_id=?", L3)?.status === "waiting");
check("waiting lead appears in list_leads", /\[waiting\]/.test(await tools(ops.ownerTools(), "list_leads").run({})));
await tools(ops.ownerTools(), "contact_client").run({ phone: "+971500003333" });
check("owner starts a waiting lead by its form number: reply goes to that same chat", outbox.at(-1)!.to === L3 && get("SELECT status FROM leads WHERE chat_id=?", L3)?.status === "active");
await tools(ops.ownerTools(), "set_sales_auto_reply").run({ on: true });
check("ai_usage reports calls and the daily limit", /Today: \$0\.00 of \$5 daily limit[\s\S]*sales chat: \d+ calls/.test(await tools(ops.ownerTools(), "ai_usage").run({})));
cfg.sales.replyTo = "everyone";

// ---- website enquiry ----
const r = await sales.handleEnquiry({ receivedAt: new Date().toISOString(), input: { kind: "enquiry", fullName: "Priya Shah", phone: "050 123 4567", email: "p@example.com", service: "Free zone setup", contactMethod: "whatsapp" } });
check("website enquiry: UAE number normalised and first message sent", r.contacted && outbox.some((o) => o.channel === "sales" && o.to === "971501234567@s.whatsapp.net"));
check("website enquiry: salesperson and owner notified", sent(SANA, /Website enquiry.*Priya Shah/s) && sent(OWNER, /Website enquiry.*Priya Shah/s));
check("enquiry details saved on the lead", JSON.parse(get("SELECT details FROM leads WHERE chat_id='971501234567@s.whatsapp.net'")!.details).service === "Free zone setup");

// ---- HTTP layer ----
await new Promise<void>((res) => server.listen(0, res));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const post = (p: string, body: string, headers: Record<string, string> = {}) => fetch(base + p, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const hook = JSON.stringify({ messages: [{ id: "http-1", type: "text", chat_id: G1, chat_name: "Acme LLC setup", from: "447700900001", from_name: "John", from_me: false, source: "mobile", timestamp: now(), text: { body: "via http" } }], event: { type: "messages", event: "post" } });
check("webhook with wrong secret is rejected", (await post("/webhooks/whapi/ops/nope", hook)).status === 401);
check("webhook with right secret is accepted", (await post("/webhooks/whapi/ops/hook-secret", hook)).status === 200);
await new Promise((res) => setTimeout(res, 100));
check("webhook message is stored", get("SELECT 1 x FROM messages WHERE id='http-1'"));
check("duplicate delivery is stored once", (await post("/webhooks/whapi/ops/hook-secret", hook)).status === 200 && all("SELECT 1 FROM messages WHERE id='http-1'").length === 1);
const enq = JSON.stringify({ input: { fullName: "Sig Test", phone: "" } });
check("enquiry with bad signature is rejected", (await post("/webhooks/enquiry", enq, { "x-unispire-signature": "00" })).status === 401);
check("enquiry with valid signature is accepted", (await post("/webhooks/enquiry", enq, { "x-unispire-signature": createHmac("sha256", "enq-secret").update(enq).digest("hex") })).status === 200);
check("health endpoint", (await fetch(base + "/health")).status === 200);
await new Promise((res) => setTimeout(res, 100));
server.close();

console.log(`\n${n - failed}/${n} checks passed`);
process.exit(failed ? 1 : 0);
