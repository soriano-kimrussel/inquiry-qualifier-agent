// local only
import "./env.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { pathToFileURL } from "node:url";
import { approve, getPending, listApproved, listPending, NotFoundError, reject } from "./approval.js";
import type { ApprovedResult, PipelineResult } from "./types.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SOFT_FLAGS = new Set(["complaint", "low_confidence", "output_check"]);
const flagClass = (id: string) => (SOFT_FLAGS.has(id) ? "amber" : "red");
const label = (id: string) => id.replace(/_/g, " ");

function pendingCard(item: PipelineResult): string {
  const q = item.qualification;
  const flags = item.guardrails.fired.length
    ? item.guardrails.fired.map((g) => `<span class="badge ${flagClass(g)}">${esc(label(g))}</span>`).join("")
    : '<span class="badge green">No guardrails fired</span>';
  const review = item.crmNote.humanReviewRequired ? '<span class="badge review">Needs human review</span>' : "";
  const decisions = item.guardrails.decisions
    .map(
      (d) =>
        `<li class="${flagClass(d.id)}"><div><b>${esc(label(d.id))}</b> <span class="muted">(${esc(d.source)})</span></div>
           <div>${esc(d.reason)}</div><div class="muted">${esc(d.actions.join(" · "))}</div></li>`,
    )
    .join("");
  const replyBlock =
    item.reply.kind === "draft"
      ? `<div class="field"><span class="muted">Subject</span> <b>${esc(item.reply.subject)}</b>
           <span class="muted">· source: ${esc(item.reply.source)} · editable before approval</span></div>
         <textarea name="editedReplyBody" rows="10">${esc(item.reply.body)}</textarea>`
      : `<div class="nodraft"><b>No draft — routed to a human</b>
           <div>Guardrails blocked an outbound reply. Approving records the CRM note only; no email is queued.</div></div>
         ${item.reply.suggestedRefusal ? `<details><summary>Suggested polite refusal (send manually if warranted)</summary><pre>${esc(item.reply.suggestedRefusal)}</pre></details>` : ""}`;
  const notes = item.reply.notes.length ? `<ul class="notes">${item.reply.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  const tags = item.crmNote.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");

  return `<article class="card">
    <header class="card-head">
      <div class="ident"><h2>${esc(item.id)}</h2><span class="muted">${esc(item.brandName)}</span></div>
      <div class="badges"><span class="badge neutral">${esc(label(q.intent))}</span>${flags}${review}</div>
    </header>
    <div class="facts">
      <span><span class="muted">From</span> ${esc(item.inquiry.from.name)} &lt;${esc(item.inquiry.from.email ?? "no email")}&gt;</span>
      <span><span class="muted">Confidence</span> ${esc(q.confidence)}</span>
      <span><span class="muted">Party</span> ${esc(q.partySize ?? "n/a")}</span>
      <span><span class="muted">Date</span> ${esc(q.requestedDate ?? "n/a")}</span>
    </div>

    <section>
      <h3>Inquiry${item.inquiry.redacted ? ' <span class="badge red">redacted</span>' : ""}</h3>
      <blockquote>${item.inquiry.subject ? `<b>${esc(item.inquiry.subject)}</b>\n\n` : ""}${esc(item.inquiry.message)}</blockquote>
    </section>

    ${decisions ? `<section><h3>Guardrail decisions</h3><ul class="decisions">${decisions}</ul></section>` : ""}

    <section>
      <h3>CRM note</h3>
      <dl class="crm">
        <dt>Summary</dt><dd>${esc(item.crmNote.summary)}</dd>
        <dt>Next action</dt><dd>${esc(item.crmNote.nextBestAction)}</dd>
        <dt>Tags</dt><dd>${tags}</dd>
      </dl>
    </section>

    <form method="post" action="/pending/${esc(item.id)}/approve">
      <section>
        <h3>Reply</h3>
        ${replyBlock}
        ${notes}
      </section>
      <footer class="card-foot">
        <span class="muted meta">${esc(item.llm.model)} via ${esc(item.llm.provider)} · ${esc(item.llm.totalTokens)} tokens · ${esc(item.llm.totalLatencyMs)} ms</span>
        <span class="actions">
          <label class="muted">Reviewer <input name="approvedBy" value="reviewer" required></label>
          <button type="submit" class="reject" formaction="/pending/${esc(item.id)}/reject">Reject</button>
          <button type="submit" class="approve">Approve</button>
        </span>
      </footer>
    </form>
  </article>`;
}

function approvedRow(item: ApprovedResult): string {
  const i = item.integrations;
  return `<tr><td><b>${esc(item.id)}</b></td><td>${esc(item.approval.approvedBy)}</td><td>${esc(item.approval.approvedAt)}</td>
    <td>ghl: ${esc(i.ghl.status)}<br>calendar: ${esc(i.calendar.status)}<br>email: ${esc(i.email.status)}</td></tr>`;
}

const STYLES = `
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#1f2937}
  .topbar{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #e5e7eb}
  .topbar-in{max-width:960px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  h1{margin:0;font-size:19px;font-weight:650}
  .count{display:inline-flex;align-items:center;gap:8px;font-size:14px;color:#4b5563}
  .count b{background:#1f2937;color:#fff;border-radius:999px;min-width:28px;padding:2px 10px;text-align:center;font-size:14px}
  main{max-width:960px;margin:0 auto;padding:20px 24px 56px}
  .intro{color:#4b5563;margin:0 0 16px}
  .flash{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:10px 14px;border-radius:8px;margin:0 0 16px}
  .empty{background:#fff;border:1px dashed #d1d5db;border-radius:10px;padding:28px;text-align:center;color:#6b7280}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin:0 0 24px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  .card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid #eef0f3}
  .ident{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  h2{margin:0;font-size:17px;font-weight:650}
  .badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid transparent;white-space:nowrap}
  .badge.neutral{background:#f3f4f6;color:#374151;border-color:#e5e7eb}
  .badge.green{background:#ecfdf3;color:#166534;border-color:#bbf7d0}
  .badge.amber{background:#fffbeb;color:#92400e;border-color:#fde68a}
  .badge.red{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
  .badge.review{background:#b91c1c;color:#fff}
  .facts{display:flex;gap:6px 24px;flex-wrap:wrap;padding:12px 20px 0;font-size:14px}
  .muted{color:#6b7280;font-weight:400}
  section{padding:16px 20px 0}
  h3{margin:0 0 8px;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}
  blockquote{margin:0;padding:12px 16px;background:#f9fafb;border-left:3px solid #9ca3af;border-radius:0 8px 8px 0;white-space:pre-wrap;color:#111827}
  .decisions{list-style:none;margin:0;padding:0;display:grid;gap:8px}
  .decisions li{padding:8px 12px;border-radius:8px;border-left:3px solid;font-size:14px}
  .decisions li.amber{background:#fffbeb;border-color:#f59e0b}
  .decisions li.red{background:#fef2f2;border-color:#dc2626}
  .crm{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:0;font-size:14px}
  .crm dt{color:#6b7280}.crm dd{margin:0}
  .tag{display:inline-block;margin:0 6px 4px 0;padding:1px 8px;border-radius:6px;background:#f3f4f6;border:1px solid #e5e7eb;font-size:12px;color:#374151}
  .field{font-size:14px;margin-bottom:6px}
  textarea{width:100%;font-family:inherit;font-size:14px;line-height:1.55;padding:12px 14px;border:1px solid #d1d5db;border-radius:8px;resize:vertical;color:#111827}
  textarea:focus,input:focus{outline:2px solid #93c5fd;outline-offset:1px}
  .nodraft{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:12px 14px}
  .nodraft div{color:#7f1d1d;font-size:14px}
  details{margin-top:10px;font-size:14px}summary{cursor:pointer;color:#4b5563}
  pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:8px 0 0;font:inherit;font-size:14px}
  .notes{margin:10px 0 0;padding-left:18px;color:#6b7280;font-size:13px}
  .card-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;padding:14px 20px;border-top:1px solid #eef0f3;background:#fafbfc;border-radius:0 0 10px 10px}
  .meta{font-size:13px}
  .actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  input{padding:7px 10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:14px;width:130px;margin-left:6px}
  button{padding:9px 22px;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;border:1px solid transparent}
  .approve{background:#15803d;color:#fff}.approve:hover{background:#166534}
  .reject{background:#fff;color:#b91c1c;border-color:#fca5a5}.reject:hover{background:#fef2f2}
  .section-title{margin:32px 0 12px;font-size:16px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px}
  th{background:#f9fafb;color:#6b7280;font-weight:650;text-transform:uppercase;letter-spacing:.05em;font-size:11px}
  td,th{padding:10px 14px;text-align:left;vertical-align:top;border-bottom:1px solid #eef0f3}
  tr:last-child td{border-bottom:0}
  code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px}
`;

function page(pending: PipelineResult[], approved: ApprovedResult[], flash: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approval queue</title>
<style>${STYLES}</style></head><body>
<div class="topbar"><div class="topbar-in">
  <h1>Approval queue</h1>
  <span class="count"><b>${pending.length}</b> pending</span>
</div></div>
<main>
<p class="intro">Nothing is sent automatically. Approving an item writes <b>simulated</b> GoHighLevel, calendar, and email objects to <code>out/integrations/</code>.</p>
${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
${pending.length === 0 ? '<p class="empty">No pending items. Run <code>npm run pipeline</code> to create some.</p>' : ""}
${pending.map(pendingCard).join("\n")}
<h2 class="section-title">Approved (${approved.length})</h2>
${approved.length ? `<table><tr><th>ID</th><th>Approved by</th><th>At</th><th>Simulated integrations</th></tr>${approved.map(approvedRow).join("")}</table>` : '<p class="muted">None yet.</p>'}
</main>
</body></html>`;
}

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (req, res) => {
    const flash = typeof req.query.msg === "string" ? req.query.msg : "";
    res.type("html").send(page(listPending(), listApproved(), flash));
  });

  app.get("/api/pending", (_req, res) => res.json(listPending()));
  app.get("/api/pending/:id", (req, res) => res.json(getPending(req.params.id)));
  app.post("/api/pending/:id/approve", (req, res) => {
    const body = (req.body ?? {}) as { approvedBy?: string; editedReplyBody?: string };
    res.json(approve(req.params.id, body));
  });
  app.post("/api/pending/:id/reject", (req, res) => {
    const body = (req.body ?? {}) as { rejectedBy?: string; reason?: string };
    reject(req.params.id, body);
    res.json({ id: req.params.id, status: "rejected" });
  });

  app.post("/pending/:id/approve", (req, res) => {
    const body = (req.body ?? {}) as { approvedBy?: string; editedReplyBody?: string };
    const approved = approve(req.params.id, body);
    const i = approved.integrations;
    const msg = `Approved ${approved.id}. Simulated integrations written: ghl=${i.ghl.status}, calendar=${i.calendar.status}, email=${i.email.status}.`;
    res.redirect(`/?msg=${encodeURIComponent(msg)}`);
  });
  app.post("/pending/:id/reject", (req, res) => {
    const body = (req.body ?? {}) as { approvedBy?: string };
    reject(req.params.id, { rejectedBy: body.approvedBy });
    res.redirect(`/?msg=${encodeURIComponent(`Rejected ${req.params.id}. Nothing was written to integrations.`)}`);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Approval server running at http://localhost:${port}`);
    console.log("Local only. Approving writes simulated integration files; nothing is sent anywhere.");
  });
}
