import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { approve, listPending } from "../src/approval.js";
import { checkResult, loadCases, runEvals, writeResults } from "../src/eval.js";
import { runPipeline } from "../src/pipeline.js";
import { createApp } from "../src/server.js";
import type { PipelineResult } from "../src/types.js";
import { startStubLlm, type StubLlm } from "./helpers/stub-llm.js";

let stub: StubLlm;
let outDir: string;
const readJson = (...parts: string[]) => JSON.parse(readFileSync(path.join(outDir, ...parts), "utf8"));
const pending = (id: string) => readJson("pending", `${id}.json`) as PipelineResult;

before(async () => {
  stub = await startStubLlm();
  outDir = mkdtempSync(path.join(tmpdir(), "inquiry-agent-"));
  process.env.OUT_DIR = outDir;
  process.env.EVAL_OUT_DIR = path.join(outDir, "eval");
  process.env.LLM_BASE_URL = stub.baseUrl;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "stub-model";
});

after(async () => {
  await stub.close();
  rmSync(outDir, { recursive: true, force: true });
});

test("pipeline writes one pending result per sample inquiry", async () => {
  const summary = await runPipeline();
  assert.deepEqual(summary.failed, []);
  assert.ok(summary.processed.length >= 10);
  assert.equal(readdirSync(path.join(outDir, "pending")).length, summary.processed.length);

  for (const item of listPending()) {
    assert.equal(item.status, "pending_approval");
    assert.equal(item.autoSent, false);
    assert.equal(item.guardrails.approvalRequired, true);
    assert.ok(item.llm.calls.length >= 1);
    assert.ok(item.llm.totalTokens > 0);
    assert.equal(item.crmNote.humanReviewRequired, item.guardrails.fired.length > 0);
  }
});

test("guardrail samples behave as specified", () => {
  const jailbreak = pending("ba-005");
  assert.ok(jailbreak.guardrails.fired.includes("off_policy"));
  assert.equal(jailbreak.reply.kind, "none");
  assert.equal(jailbreak.llm.calls.length, 1, "no draft call is made for blocked items");

  const minor = pending("st-002");
  assert.ok(minor.guardrails.fired.includes("alcohol_age_gate"));
  assert.match(minor.reply.body ?? "", /21/);

  const confirmedAdults = pending("st-001");
  assert.deepEqual(confirmedAdults.guardrails.fired, []);

  const health = pending("pb-002");
  assert.ok(health.guardrails.fired.includes("sensitive_health_info"));
  assert.doesNotMatch(JSON.stringify(health), /lupus|isotretinoin/i);

  const therapy = pending("ba-003");
  assert.ok(therapy.guardrails.fired.includes("therapy_framing"));

  assert.equal(pending("st-005").reply.kind, "none");
  assert.equal(pending("st-004").reply.kind, "none");
});

test("approving a clean booking writes GHL, calendar-hold, and queued-email objects", () => {
  const approved = approve("st-001", { approvedBy: "tester" });
  assert.ok(!existsSync(path.join(outDir, "pending", "st-001.json")));
  assert.equal(readJson("approved", "st-001.json").status, "approved");

  const ghl = readJson("integrations", "ghl", "st-001.json");
  assert.equal(ghl._simulation, true);
  assert.equal(ghl.locationId, "[GHL LOCATION]");
  assert.equal(ghl.contact.email, "renee.castillo@example.com");

  const hold = readJson("integrations", "calendar", "st-001.json");
  assert.equal(hold.status, "tentative_hold");
  assert.equal(hold.date, "2026-12-12");
  assert.equal(Date.parse(hold.expiresAt) - Date.parse(approved.approval.approvedAt), 48 * 3_600_000);

  const email = readJson("integrations", "email", "st-001.json");
  assert.equal(email.status, "queued_draft");
  assert.equal(email.sendMode, "draft_only");
});

test("approving a blocked item queues no email and places no hold", () => {
  approve("ba-005");
  assert.equal(readJson("integrations", "email", "ba-005.json").status, "no_email");
  assert.equal(readJson("integrations", "calendar", "ba-005.json").status, "no_hold");
  assert.doesNotMatch(JSON.stringify(readJson("integrations", "ghl", "ba-005.json")), /system prompt/i);
});

test("health details never reach the simulated integrations", () => {
  approve("pb-002");
  for (const name of ["ghl", "calendar", "email"]) {
    assert.doesNotMatch(JSON.stringify(readJson("integrations", name, "pb-002.json")), /lupus|isotretinoin/i);
  }
});

test("approval server lists pending items and approves over HTTP", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const list = (await (await fetch(`${base}/api/pending`)).json()) as PipelineResult[];
    assert.ok(list.some((i) => i.id === "ba-001"));
    assert.match(await (await fetch(base)).text(), /Approval queue/);

    const res = await fetch(`${base}/api/pending/ba-001/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedBy: "http-tester", editedReplyBody: "Edited by a human. [BOOKING LINK]" }),
    });
    assert.equal(res.status, 200);
    assert.equal(readJson("integrations", "email", "ba-001.json").body, "Edited by a human. [BOOKING LINK]");
    assert.equal(readJson("approved", "ba-001.json").approval.replyEdited, true);

    assert.equal((await fetch(`${base}/api/pending/ba-001/approve`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/api/pending/..%2F..%2Fpackage/approve`, { method: "POST" })).status, 404);
  } finally {
    server.close();
  }
});

test("output checks replace a misbehaving draft", async () => {
  const bad = await startStubLlm({ badDrafts: true });
  process.env.LLM_BASE_URL = bad.baseUrl;
  try {
    const { processInquiry } = await import("../src/pipeline.js");
    const result = await processInquiry({
      id: "bad-1",
      business: "sidecar-tours",
      receivedAt: "2026-11-20T10:00:00Z",
      from: { name: "Sam Poole", email: "sam@example.com" },
      message: "Book the brewery tour for 2 please.",
    });
    assert.equal(result.reply.source, "fallback_template");
    assert.doesNotMatch(result.reply.body ?? "", /confirmed|\$45|https?:/);
    assert.equal(result.crmNote.humanReviewRequired, true);
  } finally {
    process.env.LLM_BASE_URL = stub.baseUrl;
    await bad.close();
  }
});

test("eval runner scores from real output and writes markdown + CSV", async () => {
  const cases = loadCases();
  assert.ok(cases.length >= 15);
  const rows = await runEvals(cases.slice(0, 3));
  const files = writeResults(rows, { model: "stub-model", provider: "stub" });
  const md = readFileSync(files.md, "utf8");
  assert.match(md, /\| id \| input \| expected \| actual summary \| pass\/fail \| latency \(ms\) \| notes \|/);
  assert.equal(readFileSync(files.csv, "utf8").trim().split("\n").length, 4);

  const failures = checkResult(pending("st-002"), { outboundDraft: false, guardrails: ["spam"] });
  assert.equal(failures.length, 2);
});
