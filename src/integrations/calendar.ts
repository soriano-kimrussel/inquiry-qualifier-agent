// simulation only, writes a file
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBusinessConfig } from "../config.js";
import { paths } from "../paths.js";
import type { ApprovalRecord, PipelineResult } from "../types.js";

const HOLD_EXPIRY_HOURS = 48;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function writeCalendarHold(result: Omit<PipelineResult, "status">, approval: ApprovalRecord) {
  const config = loadBusinessConfig(result.business);
  const base = {
    _simulation: true,
    _notice: "Simulated calendar hold. No calendar system was contacted.",
    inquiryId: result.id,
    business: result.business,
  };

  let object: Record<string, unknown>;
  if (!result.guardrails.calendarHoldAllowed) {
    const reason =
      result.qualification.intent !== "booking"
        ? `Intent is "${result.qualification.intent}", not a booking.`
        : `Guardrails fired (${result.guardrails.fired.join(", ")}); scheduling is left to the human reviewer.`;
    object = { ...base, status: "no_hold", reason };
  } else {
    const requested = result.qualification.requestedDate;
    const isoDate = requested && ISO_DATE.test(requested) ? requested : null;
    // expiry from code, not the model
    const expiresAt = new Date(Date.parse(approval.approvedAt) + HOLD_EXPIRY_HOURS * 3_600_000).toISOString();
    object = {
      ...base,
      status: "tentative_hold",
      holdId: `hold-${result.id}`,
      title: `HOLD: ${result.inquiry.from.name} (${config.brandName})`,
      date: isoDate,
      requestedDateText: requested,
      needsDateConfirmation: isoDate === null,
      partySize: result.qualification.partySize,
      durationMinutes: config.defaultHoldMinutes,
      attendee: { name: result.inquiry.from.name, email: result.inquiry.from.email ?? null },
      expiresAt,
      createdBy: approval.approvedBy,
    };
  }

  const dir = paths.integrations("calendar");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.id}.json`);
  writeFileSync(file, JSON.stringify(object, null, 2));
  console.log(`[SIMULATION] Calendar: ${object.status} written to ${file} (no network call)`);
  return { status: String(object.status), file };
}
