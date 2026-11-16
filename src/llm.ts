import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config, env, localDate, now } from "./config.ts";
import { get, kvGet, kvSet, run } from "./db.ts";
import { trySend } from "./whapi.ts";

let client: Anthropic | undefined;
const api = () => (client ??= new Anthropic());

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string> | string;
}
export const tool = <S extends z.ZodObject>(t: ToolSpec<S>) => t as unknown as ToolSpec;

export type Turn = { role: "user" | "assistant"; content: string };

// USD per million tokens: [input, output, cache read]. Cache writes cost 1.25x input.
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

interface Usage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** Log one API call's tokens and cost so spending can be reported and capped. */
function record(purpose: string, model: string, u: Usage | undefined) {
  const [pi, po, pc] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const i = u?.input_tokens ?? 0, o = u?.output_tokens ?? 0, cr = u?.cache_read_input_tokens ?? 0, cw = u?.cache_creation_input_tokens ?? 0;
  const cost = (i * pi + o * po + cr * pc + cw * pi * 1.25) / 1e6;
  run("INSERT INTO usage (ts, day, purpose, model, input, output, cache_read, cache_write, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)", now(), localDate(), purpose, model, i, o, cr, cw, cost);
}

export const spentToday = () => Number(get("SELECT coalesce(sum(cost_usd),0) c FROM usage WHERE day=?", localDate())!.c);

/** False once today's spend has reached the daily limit; the owner is told once. */
async function withinBudget() {
  if (env.dailyBudgetUsd <= 0 || spentToday() < env.dailyBudgetUsd) return true;
  if (kvGet("budget_alert_day") !== localDate()) {
    kvSet("budget_alert_day", localDate());
    await trySend("ops", config.owner.phone, `⚠️ Today's AI spending limit ($${env.dailyBudgetUsd}) is reached. The agents will not write or judge messages until tomorrow. Messages are still received and saved.`);
  }
  return false;
}

const textOf = (content: { type: string }[]) =>
  content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();

/**
 * Run one agent turn: Claude may call the given tools, then returns the text to send on WhatsApp.
 * Returns "" when there is nothing to send (refusal or empty reply).
 */
export async function runAgent(opts: { purpose: string; system: string; turns: Turn[]; tools?: ToolSpec[]; effort?: "low" | "medium" | "high" }) {
  if (!(await withinBudget())) return "";
  if (env.fakeLlm) { record(opts.purpose, "fake", undefined); return process.env.LLM_FAKE_REPLY ?? `FAKE_REPLY to: ${opts.turns.at(-1)?.content ?? ""}`; }
  const runner = api().beta.messages.toolRunner({
    model: env.model,
    max_tokens: 16000,
    max_iterations: 8,
    // If the main model declines a request, the API retries it on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "medium" },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: (opts.tools ?? []).map((t) =>
      betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: async (input) => String(await t.run(input)) }),
    ),
    messages: opts.turns,
  });
  // One model call per loop turn (more when tools are used); record each so the spend log is complete.
  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    final = message;
    record(opts.purpose, message.model ?? env.model, message.usage);
  }
  if (!final) return "";
  if (final.stop_reason === "refusal") {
    console.error("model declined:", final.stop_details);
    return "";
  }
  return textOf(final.content);
}

const Triage = z.object({
  needs_reply: z.boolean().describe("true if the client is still waiting for an answer or action from the team"),
  summary: z.string().describe("one short sentence: what the client is waiting for"),
});

/** Decide whether the client's latest unanswered messages in a group actually need a team reply. */
export async function triage(groupName: string, transcriptText: string): Promise<z.infer<typeof Triage>> {
  if (env.fakeLlm) {
    const last = transcriptText.trim().split("\n").at(-1) ?? "";
    return { needs_reply: !/:\s*((ok|okay|thanks|thank you|noted|👍)[.! ]*)+$/i.test(last), summary: last.split(": ").slice(1).join(": ").slice(0, 120) };
  }
  if (!(await withinBudget())) return { needs_reply: true, summary: "Unanswered client message (not checked: AI limit reached)" };
  const res = await api().messages.parse({
    model: env.lightModel,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Triage) },
    system:
      "You review a WhatsApp group between a UAE business-setup consultancy (TEAM) and its client (CUSTOMER). " +
      "The client's most recent messages have had no team reply. Decide if the client is waiting for a response. " +
      "A question, request, document sent for review, complaint or follow-up needs a reply. " +
      "A closing remark such as thanks, ok, noted, or an emoji does not.",
    messages: [{ role: "user", content: `Group: ${groupName}\n\n${transcriptText}` }],
  });
  record("group check", res.model ?? env.lightModel, res.usage);
  return res.parsed_output ?? { needs_reply: true, summary: "Unanswered client message" };
}
