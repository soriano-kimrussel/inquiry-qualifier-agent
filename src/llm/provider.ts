import { z } from "zod";
import type { LlmCallRecord } from "../types.js";

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_MODEL = "gemini-flash-latest";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly call?: LlmCallRecord,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function loadLlmConfig(): LlmConfig {
  const baseUrl = (process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || /^your-.*-here$/.test(apiKey)) {
    throw new LlmError(
      "LLM_API_KEY is not set. Copy .env.example to .env and add your key " +
        "(free Gemini key: https://aistudio.google.com/apikey).",
    );
  }
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 60_000,
    maxRetries: process.env.LLM_MAX_RETRIES ? Number(process.env.LLM_MAX_RETRIES) : 4,
  };
}

export function providerLabel(): string {
  try {
    return new URL(process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).host;
  } catch {
    return "invalid LLM_BASE_URL";
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResult {
  content: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// some providers reject json mode, drop it once
let jsonModeSupported = true;

function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 90_000);
  const hinted = body.match(/retry(?:Delay)?["\s:]*(?:in\s*)?"?([\d.]+)s/i);
  if (hinted?.[1]) return Math.min(Math.ceil(Number(hinted[1]) * 1000) + 500, 90_000);
  return Math.min(5_000 * 2 ** attempt, 60_000);
}

async function chatCompletion(
  cfg: LlmConfig,
  messages: ChatMessage[],
  temperature: number,
): Promise<ChatResult> {
  const url = `${cfg.baseUrl}/chat/completions`;
  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = { model: cfg.model, messages, temperature };
    if (jsonModeSupported) body.response_format = { type: "json_object" };

    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (attempt < cfg.maxRetries) {
        const wait = Math.min(2_000 * 2 ** attempt, 30_000);
        console.error(`  [llm] network error (${(err as Error).message}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new LlmError(`Could not reach ${url}: ${(err as Error).message}`);
    }
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();

    if (res.ok) {
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError(`Provider returned a non-JSON HTTP body: ${text.slice(0, 200)}`);
      }
      const usage = json?.usage ?? {};
      const promptTokens = Number(usage.prompt_tokens) || 0;
      const completionTokens = Number(usage.completion_tokens) || 0;
      return {
        content: String(json?.choices?.[0]?.message?.content ?? ""),
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: Number(usage.total_tokens) || promptTokens + completionTokens,
      };
    }

    if (res.status === 400 && jsonModeSupported && /response_format|json_object|json mode/i.test(text)) {
      jsonModeSupported = false;
      console.error("  [llm] provider rejected response_format; continuing without JSON mode");
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < cfg.maxRetries) {
      const wait = retryDelayMs(res, text, attempt);
      console.error(`  [llm] HTTP ${res.status} (rate limit / transient); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }

    const hint =
      res.status === 404
        ? ` Model "${cfg.model}" may not exist on this provider — run "npm run check" to list available models, then set LLM_MODEL.`
        : res.status === 401 || res.status === 403 || /api key/i.test(text)
          ? " Check LLM_API_KEY."
          : "";
    throw new LlmError(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}${hint}`);
  }
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) text = fenced[1];
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `not parseable as JSON (${(err as Error).message})` };
  }
}

export interface StructuredCallOptions<T extends z.ZodType> {
  step: string;
  system: string;
  user: string;
  schema: T;
  temperature?: number;
}

export async function callStructured<T extends z.ZodType>(
  opts: StructuredCallOptions<T>,
): Promise<{ data: z.infer<T>; call: LlmCallRecord }> {
  const cfg = loadLlmConfig();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `${opts.system}\n\n` +
        "OUTPUT FORMAT: respond with one JSON object and nothing else (no markdown fences, no commentary). " +
        `It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(opts.schema))}`,
    },
    { role: "user", content: opts.user },
  ];
  const call: LlmCallRecord = {
    step: opts.step,
    model: cfg.model,
    attempts: 0,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await chatCompletion(cfg, messages, opts.temperature ?? 0);
    call.attempts = attempt;
    call.latencyMs += res.latencyMs;
    call.promptTokens += res.promptTokens;
    call.completionTokens += res.completionTokens;
    call.totalTokens += res.totalTokens;

    const parsed = parseJson(res.content);
    if (parsed.ok) {
      const validated = opts.schema.safeParse(parsed.value);
      if (validated.success) return { data: validated.data, call };
      lastError = `failed schema validation: ${z.prettifyError(validated.error)}`;
    } else {
      lastError = parsed.error;
    }
    messages.push(
      { role: "assistant", content: res.content || "(empty response)" },
      { role: "user", content: `That response was invalid: ${lastError}\nReturn only the corrected JSON object.` },
    );
  }
  throw new LlmError(`[${opts.step}] model output still invalid after one retry: ${lastError}`, call);
}

export async function listModels(): Promise<string[]> {
  const cfg = loadLlmConfig();
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new LlmError(`HTTP ${res.status} listing models: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => String(m.id ?? "").replace(/^models\//, "")).filter(Boolean);
}
