import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "./config.ts";

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

const textOf = (content: { type: string }[]) =>
  content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();

/**
 * Run one agent turn: Claude may call the given tools, then returns the text to send on WhatsApp.
 * Returns "" when there is nothing to send (refusal or empty reply).
 */
export async function runAgent(opts: { system: string; turns: Turn[]; tools?: ToolSpec[]; effort?: "low" | "medium" | "high" }) {
  if (env.fakeLlm) return process.env.LLM_FAKE_REPLY ?? `FAKE_REPLY to: ${opts.turns.at(-1)?.content ?? ""}`;
  const final = await api().beta.messages.toolRunner({
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
  const res = await api().messages.parse({
    model: env.model,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Triage) },
    system:
      "You review a WhatsApp group between a UAE business-setup consultancy (TEAM) and its client (CUSTOMER). " +
      "The client's most recent messages have had no team reply. Decide if the client is waiting for a response. " +
      "A question, request, document sent for review, complaint or follow-up needs a reply. " +
      "A closing remark such as thanks, ok, noted, or an emoji does not.",
    messages: [{ role: "user", content: `Group: ${groupName}\n\n${transcriptText}` }],
  });
  return res.parsed_output ?? { needs_reply: true, summary: "Unanswered client message" };
}
