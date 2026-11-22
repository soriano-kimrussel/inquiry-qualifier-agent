import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBusinessConfig } from "./config.js";
import { draft } from "./draft.js";
import { applyGuardrails, buildBlockedOutput, enforceDraft } from "./guardrails.js";
import { loadLlmConfig, providerLabel } from "./llm/provider.js";
import { paths } from "./paths.js";
import { qualify } from "./qualify.js";
import { InquirySchema, type Inquiry, type LlmCallRecord, type PipelineResult } from "./types.js";

export async function processInquiry(input: unknown): Promise<PipelineResult> {
  const inquiry: Inquiry = InquirySchema.parse(input);
  const config = loadBusinessConfig(inquiry.business);
  const calls: LlmCallRecord[] = [];

  const qualified = await qualify(inquiry, config);
  calls.push(qualified.call);

  const ctx = applyGuardrails(inquiry, qualified.qualification, config);
  let outcome = ctx.outcome;
  let reply: PipelineResult["reply"];
  let crmNote: PipelineResult["crmNote"];

  if (outcome.outboundDraftAllowed) {
    const drafted = await draft(ctx.safeInquiry, ctx.effective, outcome, config);
    calls.push(drafted.call);
    ({ reply, crmNote, outcome } = enforceDraft(drafted.draft, ctx, config));
  } else {
    ({ reply, crmNote } = buildBlockedOutput(ctx, config));
  }

  return {
    id: inquiry.id,
    business: config.id,
    brandName: config.brandName,
    processedAt: new Date().toISOString(),
    status: "pending_approval",
    autoSent: false,
    inquiry: ctx.safeInquiry,
    qualification: ctx.effective,
    guardrails: outcome,
    reply,
    crmNote,
    llm: {
      provider: providerLabel(),
      model: loadLlmConfig().model,
      calls,
      totalTokens: calls.reduce((sum, c) => sum + c.totalTokens, 0),
      totalLatencyMs: calls.reduce((sum, c) => sum + c.latencyMs, 0),
    },
  };
}

export function loadInquiryFiles(): { file: string; data: unknown }[] {
  const dir = paths.inquiriesDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, data: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown }));
}

export interface PipelineRunSummary {
  processed: string[];
  skipped: string[];
  failed: { file: string; error: string }[];
}

export async function runPipeline(opts: { force?: boolean } = {}): Promise<PipelineRunSummary> {
  const cfg = loadLlmConfig();
  const files = loadInquiryFiles();
  mkdirSync(paths.pending(), { recursive: true });
  console.log(`Model: ${cfg.model} via ${providerLabel()}`);
  console.log(`Processing ${files.length} inquiries from ${paths.inquiriesDir()}\n`);

  const summary: PipelineRunSummary = { processed: [], skipped: [], failed: [] };
  for (const { file, data } of files) {
    const id = (data as { id?: unknown })?.id;
    if (!opts.force && typeof id === "string") {
      const decided = [paths.approved(), paths.rejected()].some((dir) => existsSync(path.join(dir, `${id}.json`)));
      if (decided) {
        console.log(`- ${file}: already approved/rejected, skipping (use --force to reprocess)`);
        summary.skipped.push(file);
        continue;
      }
    }
    try {
      const result = await processInquiry(data);
      writeFileSync(path.join(paths.pending(), `${result.id}.json`), JSON.stringify(result, null, 2));
      const flags = result.guardrails.fired.length ? result.guardrails.fired.join(", ") : "none";
      console.log(
        `✓ ${result.id}: intent=${result.qualification.intent} guardrails=[${flags}] ` +
          `reply=${result.reply.kind} tokens=${result.llm.totalTokens} latency=${result.llm.totalLatencyMs}ms`,
      );
      summary.processed.push(result.id);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`✗ ${file}: ${message}`);
      summary.failed.push({ file, error: message });
    }
  }

  console.log(
    `\nDone: ${summary.processed.length} written to ${paths.pending()}, ` +
      `${summary.skipped.length} skipped, ${summary.failed.length} failed.`,
  );
  console.log('Nothing has been sent. Run "npm run serve" to review and approve.');
  return summary;
}
