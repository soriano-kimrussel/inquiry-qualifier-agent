import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { callStructured, listModels, LlmError, loadLlmConfig } from "../src/llm/provider.js";
import { startStubLlm } from "./helpers/stub-llm.js";

const schema = z.object({ ok: z.boolean() });
const ask = () => callStructured({ step: "check", system: "Reply with JSON.", user: "ping", schema });

function pointAt(baseUrl: string) {
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "stub-model";
}

test("defaults to the Gemini OpenAI-compatible endpoint; three env vars switch provider", () => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  process.env.LLM_API_KEY = "k";
  const gemini = loadLlmConfig();
  assert.equal(gemini.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.match(gemini.model, /^gemini-/);

  process.env.LLM_BASE_URL = "https://api.x.ai/v1";
  process.env.LLM_MODEL = "grok-test";
  const xai = loadLlmConfig();
  assert.equal(xai.baseUrl, "https://api.x.ai/v1");
  assert.equal(xai.model, "grok-test");
});

test("missing or placeholder key gives a clear error", () => {
  process.env.LLM_API_KEY = "your-gemini-key-here";
  assert.throws(() => loadLlmConfig(), /LLM_API_KEY is not set/);
});

test("returns schema-validated JSON and records tokens and latency", async () => {
  const stub = await startStubLlm();
  try {
    pointAt(stub.baseUrl);
    const { data, call } = await ask();
    assert.deepEqual(data, { ok: true });
    assert.equal(call.attempts, 1);
    assert.equal(call.totalTokens, 120);
    assert.ok(call.latencyMs >= 0);
    const req = stub.requests[0]!;
    assert.equal(req.path, "/v1/chat/completions");
    assert.equal(req.auth, "Bearer test-key");
    assert.equal(req.body.model, "stub-model");
    assert.deepEqual(await listModels(), ["stub-model"]);
  } finally {
    await stub.close();
  }
});

test("retries once on invalid JSON and sums usage across attempts", async () => {
  const stub = await startStubLlm({ invalidJsonFirst: 1 });
  try {
    pointAt(stub.baseUrl);
    const { data, call } = await ask();
    assert.deepEqual(data, { ok: true });
    assert.equal(call.attempts, 2);
    assert.equal(call.totalTokens, 240);
    assert.match(stub.requests[1]!.body.messages.at(-1).content, /invalid/);
  } finally {
    await stub.close();
  }
});

test("gives up after one retry", async () => {
  const stub = await startStubLlm({ invalidJsonFirst: 2 });
  try {
    pointAt(stub.baseUrl);
    await assert.rejects(ask(), (err: unknown) => err instanceof LlmError && /still invalid after one retry/.test(err.message));
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test("waits and retries on HTTP 429", async () => {
  const stub = await startStubLlm({ rateLimitFirst: 1 });
  try {
    pointAt(stub.baseUrl);
    const { data, call } = await ask();
    assert.deepEqual(data, { ok: true });
    assert.equal(call.attempts, 1);
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

// keep last, turns json mode off for the process
test("falls back when a provider rejects response_format", async () => {
  const stub = await startStubLlm({ rejectResponseFormat: true });
  try {
    pointAt(stub.baseUrl);
    const { data } = await ask();
    assert.deepEqual(data, { ok: true });
    assert.ok(stub.requests[0]!.body.response_format);
    assert.equal(stub.requests[1]!.body.response_format, undefined);
  } finally {
    await stub.close();
  }
});
