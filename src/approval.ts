import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeCalendarHold } from "./integrations/calendar.js";
import { writeQueuedEmail } from "./integrations/email.js";
import { writeGhlPayload } from "./integrations/ghl.js";
import { paths } from "./paths.js";
import type { ApprovalRecord, ApprovedResult, PipelineResult } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class NotFoundError extends Error {}

function readDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as T);
}

export const listPending = () => readDir<PipelineResult>(paths.pending());
export const listApproved = () => readDir<ApprovedResult>(paths.approved());

export function getPending(id: string): PipelineResult {
  // id is used as a file name
  if (!ID_RE.test(id)) throw new NotFoundError(`Invalid id "${id}"`);
  const file = path.join(paths.pending(), `${id}.json`);
  if (!existsSync(file)) throw new NotFoundError(`No pending item "${id}"`);
  return JSON.parse(readFileSync(file, "utf8")) as PipelineResult;
}

export function approve(id: string, opts: { approvedBy?: string; editedReplyBody?: string } = {}): ApprovedResult {
  const pending = getPending(id);
  const { status: _status, ...rest } = pending;

  const edited = opts.editedReplyBody?.replace(/\r\n/g, "\n").trim();
  const replyEdited = rest.reply.kind === "draft" && !!edited && edited !== rest.reply.body?.trim();
  if (replyEdited) rest.reply = { ...rest.reply, body: edited! };

  const approval: ApprovalRecord = {
    approvedBy: opts.approvedBy?.trim() || "reviewer",
    approvedAt: new Date().toISOString(),
    replyEdited,
  };

  const integrations = {
    ghl: writeGhlPayload(rest, approval),
    calendar: writeCalendarHold(rest, approval),
    email: writeQueuedEmail(rest, approval),
  };

  const approved: ApprovedResult = { ...rest, status: "approved", approval, integrations };
  mkdirSync(paths.approved(), { recursive: true });
  writeFileSync(path.join(paths.approved(), `${id}.json`), JSON.stringify(approved, null, 2));
  rmSync(path.join(paths.pending(), `${id}.json`));
  return approved;
}

export function reject(id: string, opts: { rejectedBy?: string; reason?: string } = {}): void {
  const pending = getPending(id);
  const rejected = {
    ...pending,
    status: "rejected",
    rejection: {
      rejectedBy: opts.rejectedBy?.trim() || "reviewer",
      rejectedAt: new Date().toISOString(),
      reason: opts.reason?.trim() || null,
    },
  };
  mkdirSync(paths.rejected(), { recursive: true });
  writeFileSync(path.join(paths.rejected(), `${id}.json`), JSON.stringify(rejected, null, 2));
  rmSync(path.join(paths.pending(), `${id}.json`));
}
