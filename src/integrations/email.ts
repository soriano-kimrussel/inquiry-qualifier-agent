// simulation only, writes a file
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBusinessConfig } from "../config.js";
import { paths } from "../paths.js";
import type { ApprovalRecord, PipelineResult } from "../types.js";

export function writeQueuedEmail(result: Omit<PipelineResult, "status">, approval: ApprovalRecord) {
  const config = loadBusinessConfig(result.business);
  const base = {
    _simulation: true,
    _notice: "Simulated email queue entry. No email provider was contacted and nothing was sent.",
    inquiryId: result.id,
  };

  let object: Record<string, unknown>;
  if (result.reply.kind !== "draft" || !result.reply.body) {
    object = {
      ...base,
      status: "no_email",
      reason: "Guardrails blocked an outbound draft for this inquiry.",
    };
  } else if (!result.inquiry.from.email) {
    object = { ...base, status: "no_email", reason: "Inquiry has no email address." };
  } else {
    object = {
      ...base,
      status: "queued_draft",
      sendMode: "draft_only",
      to: result.inquiry.from.email,
      fromName: config.brandName,
      subject: result.reply.subject,
      body: result.reply.body,
      unresolvedPlaceholders: Object.values(config.placeholders).filter((p) => result.reply.body?.includes(p)),
      approvedBy: approval.approvedBy,
      queuedAt: approval.approvedAt,
    };
  }

  const dir = paths.integrations("email");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.id}.json`);
  writeFileSync(file, JSON.stringify(object, null, 2));
  console.log(`[SIMULATION] Email: ${object.status} written to ${file} (nothing sent)`);
  return { status: String(object.status), file };
}
