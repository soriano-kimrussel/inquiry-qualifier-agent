// simulation only, writes a file
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBusinessConfig } from "../config.js";
import { paths } from "../paths.js";
import type { ApprovalRecord, PipelineResult } from "../types.js";

export function writeGhlPayload(result: Omit<PipelineResult, "status">, approval: ApprovalRecord) {
  const config = loadBusinessConfig(result.business);
  const [firstName, ...rest] = result.inquiry.from.name.trim().split(/\s+/);
  const payload = {
    _simulation: true,
    _notice: "Simulated GoHighLevel payload. Nothing was sent to any API.",
    wouldCall: ["POST /contacts/upsert", "POST /contacts/{contactId}/notes"],
    locationId: config.placeholders.ghlLocation,
    contact: {
      firstName: firstName ?? "",
      lastName: rest.join(" "),
      email: result.inquiry.from.email ?? null,
      phone: result.inquiry.from.phone ?? null,
      source: `inquiry-agent:${result.inquiry.channel}`,
      tags: result.crmNote.tags,
    },
    note: {
      body: [
        `Summary: ${result.crmNote.summary}`,
        `Next best action: ${result.crmNote.nextBestAction}`,
        `Intent: ${result.qualification.intent} (confidence ${result.qualification.confidence})`,
        `Guardrails fired: ${result.guardrails.fired.join(", ") || "none"}`,
        `Human review required: ${result.crmNote.humanReviewRequired}`,
        `Approved by ${approval.approvedBy} at ${approval.approvedAt}`,
      ].join("\n"),
    },
    inquiryId: result.id,
  };
  const dir = paths.integrations("ghl");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.id}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`[SIMULATION] GoHighLevel: contact + note payload written to ${file} (no network call)`);
  return { status: "written", file };
}
