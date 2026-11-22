import "./env.js";
import { z } from "zod";
import { approve, listPending, NotFoundError, reject } from "./approval.js";
import { callStructured, listModels, loadLlmConfig, providerLabel } from "./llm/provider.js";
import { runPipeline } from "./pipeline.js";

const USAGE = `Usage:
  npm run pipeline [-- --force]   Run all inquiries in data/inquiries/ -> out/pending/
  npm run list                    List items waiting for approval
  npm run approve -- <id>         Approve one item (writes simulated integrations)
  npm run reject -- <id>          Reject one item
  npm run check                   Verify the API key and model, and list available models
  npm run serve                   Start the approval web UI
  npm run eval                    Run the eval cases and write the results table`;

async function check(): Promise<void> {
  const cfg = loadLlmConfig();
  console.log(`Provider: ${providerLabel()}\nModel:    ${cfg.model}\n`);
  try {
    const { data, call } = await callStructured({
      step: "check",
      system: 'Reply with the JSON object {"ok": true}.',
      user: "ping",
      schema: z.object({ ok: z.boolean() }),
    });
    console.log(`✓ Model responded (ok=${data.ok}, ${call.totalTokens} tokens, ${call.latencyMs} ms). You are ready to run the pipeline.`);
  } catch (err) {
    console.error(`✗ Test call failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
    try {
      const models = await listModels();
      console.error(`Models this key can use (set LLM_MODEL in .env to one of these):\n  ${models.join("\n  ")}`);
    } catch (listErr) {
      console.error(`Could not list models either: ${(listErr as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "pipeline": {
      const summary = await runPipeline({ force: args.includes("--force") });
      if (summary.failed.length > 0) process.exitCode = 1;
      break;
    }
    case "list": {
      const pending = listPending();
      if (pending.length === 0) console.log("No pending items.");
      for (const item of pending) {
        console.log(
          `${item.id}\t${item.qualification.intent}\tguardrails=[${item.guardrails.fired.join(", ")}]\treply=${item.reply.kind}`,
        );
      }
      break;
    }
    case "approve":
    case "reject": {
      const id = args[0];
      if (!id) throw new Error(`Missing id. ${USAGE}`);
      if (command === "approve") {
        const approved = approve(id, { approvedBy: args[1] ?? "cli-reviewer" });
        console.log(`Approved ${approved.id} -> out/approved/${approved.id}.json`);
      } else {
        reject(id, { rejectedBy: args[1] ?? "cli-reviewer" });
        console.log(`Rejected ${id} -> out/rejected/${id}.json`);
      }
      break;
    }
    case "check":
      await check();
      break;
    default:
      console.log(USAGE);
  }
}

main().catch((err: Error) => {
  console.error(err instanceof NotFoundError ? err.message : `Error: ${err.message}`);
  process.exitCode = 1;
});
