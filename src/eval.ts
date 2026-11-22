import "./env.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadLlmConfig, providerLabel } from "./llm/provider.js";
import { paths } from "./paths.js";
import { processInquiry } from "./pipeline.js";
import { INTENTS, type PipelineResult } from "./types.js";

const GUARDRAIL_IDS = ["therapy_framing", "alcohol_age_gate", "sensitive_health_info", "off_policy", "out_of_scope", "spam", "complaint", "low_confidence", "output_check"] as const;

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  business: z.string(),
  input: z.string().min(1),
  notes: z.string().default(""),
  expect: z
    .object({
      intent: z.array(z.enum(INTENTS)).optional(),
      guardrails: z.array(z.enum(GUARDRAIL_IDS)).optional(),
      guardrailsNotFired: z.array(z.enum(GUARDRAIL_IDS)).optional(),
      humanReviewRequired: z.boolean().optional(),
      outboundDraft: z.boolean().optional(),
      calendarHoldAllowed: z.boolean().optional(),
      replyIncludes: z.array(z.string()).optional(),
      replyExcludes: z.array(z.string()).optional(),
      outputExcludes: z.array(z.string()).optional(),
    })
    .strict(),
});
export type EvalCase = z.infer<typeof CaseSchema>;

export interface EvalRow {
  id: string;
  input: string;
  expected: string;
  actual: string;
  pass: boolean;
  latencyMs: number | null;
  notes: string;
}

function describeExpected(e: EvalCase["expect"]): string {
  const parts: string[] = [];
  if (e.intent) parts.push(`intent in [${e.intent.join("|")}]`);
  if (e.guardrails) parts.push(`fires [${e.guardrails.join(", ")}]`);
  if (e.guardrailsNotFired) parts.push(`does not fire [${e.guardrailsNotFired.join(", ")}]`);
  if (e.humanReviewRequired !== undefined) parts.push(`humanReview=${e.humanReviewRequired}`);
  if (e.outboundDraft !== undefined) parts.push(`outboundDraft=${e.outboundDraft}`);
  if (e.calendarHoldAllowed !== undefined) parts.push(`holdAllowed=${e.calendarHoldAllowed}`);
  if (e.replyIncludes) parts.push(`reply includes ${e.replyIncludes.map((s) => `"${s}"`).join(", ")}`);
  if (e.replyExcludes) parts.push(`reply excludes ${e.replyExcludes.map((s) => `"${s}"`).join(", ")}`);
  if (e.outputExcludes) parts.push(`output never contains ${e.outputExcludes.map((s) => `"${s}"`).join(", ")}`);
  return parts.join("; ");
}

export function checkResult(result: PipelineResult, e: EvalCase["expect"]): string[] {
  const failures: string[] = [];
  const fired = result.guardrails.fired;
  const body = (result.reply.body ?? "").toLowerCase();
  const everything = JSON.stringify(result).toLowerCase();

  if (result.autoSent !== false || result.guardrails.autoSend !== false) failures.push("item was marked auto-sent");
  if (result.status !== "pending_approval") failures.push(`status was ${result.status}, not pending_approval`);
  if (fired.length > 0 && !result.crmNote.humanReviewRequired) failures.push("guardrail fired but humanReviewRequired is false");

  if (e.intent && !e.intent.includes(result.qualification.intent)) failures.push(`intent was ${result.qualification.intent}`);
  for (const g of e.guardrails ?? []) if (!fired.includes(g)) failures.push(`${g} did not fire`);
  for (const g of e.guardrailsNotFired ?? []) if (fired.includes(g)) failures.push(`${g} fired unexpectedly`);
  if (e.humanReviewRequired !== undefined && result.crmNote.humanReviewRequired !== e.humanReviewRequired) {
    failures.push(`humanReviewRequired was ${result.crmNote.humanReviewRequired}`);
  }
  if (e.outboundDraft !== undefined && (result.reply.kind === "draft") !== e.outboundDraft) {
    failures.push(`reply.kind was ${result.reply.kind}`);
  }
  if (e.calendarHoldAllowed !== undefined && result.guardrails.calendarHoldAllowed !== e.calendarHoldAllowed) {
    failures.push(`calendarHoldAllowed was ${result.guardrails.calendarHoldAllowed}`);
  }
  for (const s of e.replyIncludes ?? []) if (!body.includes(s.toLowerCase())) failures.push(`reply missing "${s}"`);
  for (const s of e.replyExcludes ?? []) if (body.includes(s.toLowerCase())) failures.push(`reply contains "${s}"`);
  for (const s of e.outputExcludes ?? []) if (everything.includes(s.toLowerCase())) failures.push(`output leaked "${s}"`);
  return failures;
}

function describeActual(r: PipelineResult): string {
  return [
    `intent=${r.qualification.intent} (${r.qualification.confidence})`,
    `fired=[${r.guardrails.fired.join(", ")}]`,
    `humanReview=${r.crmNote.humanReviewRequired}`,
    `reply=${r.reply.kind}/${r.reply.source}`,
    `holdAllowed=${r.guardrails.calendarHoldAllowed}`,
    `redacted=${r.inquiry.redacted}`,
  ].join("; ");
}

export function loadCases(): EvalCase[] {
  const cases = z.array(CaseSchema).parse(JSON.parse(readFileSync(paths.evalCases(), "utf8")));
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate eval case id "${c.id}"`);
    ids.add(c.id);
  }
  return cases;
}

export async function runEvals(cases: EvalCase[]): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const c of cases) {
    const expected = describeExpected(c.expect);
    try {
      const result = await processInquiry({
        id: c.id,
        business: c.business,
        channel: "eval",
        receivedAt: new Date().toISOString(),
        from: { name: "Eval Customer", email: "eval.customer@example.com" },
        message: c.input,
      });
      const failures = checkResult(result, c.expect);
      rows.push({
        id: c.id,
        input: c.input,
        expected,
        actual: describeActual(result),
        pass: failures.length === 0,
        latencyMs: result.llm.totalLatencyMs,
        notes: [failures.length ? `FAILED: ${failures.join("; ")}` : "", c.notes].filter(Boolean).join(" | "),
      });
    } catch (err) {
      rows.push({
        id: c.id,
        input: c.input,
        expected,
        actual: "ERROR (no result)",
        pass: false,
        latencyMs: null,
        notes: [`ERROR: ${(err as Error).message}`, c.notes].filter(Boolean).join(" | "),
      });
    }
    const row = rows[rows.length - 1]!;
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id}  ${row.pass ? "" : row.notes}`);
  }
  return rows;
}

const mdCell = (s: string, max = 0) => {
  const flat = s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return max && flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function writeResults(rows: EvalRow[], meta: { model: string; provider: string }): { md: string; csv: string } {
  const passed = rows.filter((r) => r.pass).length;
  const timed = rows.filter((r) => r.latencyMs !== null);
  const avg = timed.length ? Math.round(timed.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / timed.length) : 0;

  const md = [
    "# Eval results",
    "",
    `- Run at: ${new Date().toISOString()}`,
    `- Model: \`${meta.model}\` via \`${meta.provider}\``,
    `- Result: **${passed}/${rows.length} passed**`,
    `- Average latency per case (model time, all calls): ${avg} ms`,
    "",
    "Pass/fail is computed from the actual pipeline output for this run. Latency is the sum of model calls for the case.",
    "",
    "| id | input | expected | actual summary | pass/fail | latency (ms) | notes |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${mdCell(r.input, 140)} | ${mdCell(r.expected)} | ${mdCell(r.actual)} | ${r.pass ? "PASS" : "FAIL"} | ${r.latencyMs ?? "n/a"} | ${mdCell(r.notes)} |`,
    ),
    "",
  ].join("\n");

  const csv = [
    "id,input,expected,actual_summary,pass_fail,latency_ms,notes",
    ...rows.map((r) =>
      [csvCell(r.id), csvCell(r.input), csvCell(r.expected), csvCell(r.actual), r.pass ? "PASS" : "FAIL", r.latencyMs ?? "", csvCell(r.notes)].join(","),
    ),
    "",
  ].join("\n");

  const dir = paths.evalResultsDir();
  mkdirSync(dir, { recursive: true });
  const mdFile = path.join(dir, "results.md");
  const csvFile = path.join(dir, "results.csv");
  writeFileSync(mdFile, md);
  writeFileSync(csvFile, csv);
  return { md: mdFile, csv: csvFile };
}

async function main(): Promise<void> {
  const cfg = loadLlmConfig();
  const cases = loadCases();
  console.log(`Running ${cases.length} eval cases on ${cfg.model} via ${providerLabel()}\n`);
  const rows = await runEvals(cases);
  const files = writeResults(rows, { model: cfg.model, provider: providerLabel() });
  const passed = rows.filter((r) => r.pass).length;
  console.log(`\n${passed}/${rows.length} passed.`);
  console.log(`Results table: ${files.md}\n               ${files.csv}`);
  if (rows.some((r) => r.latencyMs === null)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
