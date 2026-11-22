# Inquiry Qualification & Booking Follow-up Agent

A reusable agent that handles inbound customer inquiries for a portfolio of small businesses
(escape rooms, sidecar tours, a beauty studio, and an example clinic). For each inquiry it:

1. **Qualifies** it with a model (intent, party size, date, risk flags) as schema-validated JSON.
2. Applies **guardrails in deterministic code** after the model.
3. **Drafts** a customer reply and a structured CRM note with a model.
4. **Checks the draft in code** and replaces it with a fixed template if it breaks a rule.
5. Puts everything in a **human approval queue**. Nothing is ever sent automatically.
6. On approval, writes **simulated integrations** to files: a GoHighLevel contact + note payload,
   a calendar-hold object, and a queued draft email.

This is a prototype. All data is fictional sample data. There are no real integrations, no real
customer data, and the only network call is to the model API.

```
data/inquiries/*.json
      │
      ▼
  qualify (model) ──► guardrails (code) ──► draft (model) ──► output checks (code)
                                                                    │
                                                                    ▼
                                                            out/pending/*.json
                                                                    │  human approves
                                                                    ▼
                              out/approved/*.json + out/integrations/{ghl,calendar,email}/*.json
```

## Requirements

- **Node.js 22 or newer** (developed on Node 24). Check with `node -v`.
- A free Google Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). No billing needed.

No Docker, database, or other services.

## Setup

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Open `.env` and replace `your-gemini-key-here` with your Gemini key. Then confirm the key and model work:

```bash
npm run check
```

If the test call fails, `check` prints the models your key can use. Put one of them in `LLM_MODEL`.

## Run it

| Command | What it does |
|---|---|
| `npm run pipeline` | Runs every inquiry in `data/inquiries/` through qualify → guardrails → draft and writes one result file per inquiry to `out/pending/`. |
| `npm run serve` | Starts the approval server at http://localhost:3000. Review each item, edit the reply if needed, then Approve or Reject. |
| `npm run eval` | Runs the cases in `evals/cases.json` through the same pipeline and writes the results table. |
| `npm run check` | Verifies the key and model. |
| `npm test` | Unit and end-to-end tests. These use a local stub provider, so they need no key. |
| `npm run typecheck` | TypeScript check. |

Command-line alternatives to the web UI: `npm run list`, `npm run approve -- <id>`, `npm run reject -- <id>`.

`npm run pipeline` skips inquiries that were already approved or rejected. Use `npm run pipeline -- --force`
to reprocess them, or delete the `out/` folder to start again.

The free Gemini tier is rate limited. When the provider returns HTTP 429 the adapter waits and retries,
so a full run can pause for up to a minute now and then. That is expected.

## Where outputs land

| Path | Contents |
|---|---|
| `out/pending/<id>.json` | One result per inquiry: the (redacted) inquiry, qualification, guardrail decisions, reply, CRM note, tokens, and latency per model call. |
| `out/approved/<id>.json` | The approved item, who approved it and when, and which integration files were written. |
| `out/rejected/<id>.json` | Rejected items. No integrations are written for these. |
| `out/integrations/ghl/<id>.json` | Simulated GoHighLevel contact + note payload. |
| `out/integrations/calendar/<id>.json` | Simulated calendar hold, or `no_hold` with the reason. |
| `out/integrations/email/<id>.json` | Simulated queued draft email, or `no_email` with the reason. |
| `evals/results/results.md` and `results.csv` | The eval results table. |

`out/` is gitignored. `evals/results/` is not, so a results table can be committed as evidence.

## Switching to Grok / xAI

The model layer (`src/llm/provider.ts`) calls the OpenAI-compatible `POST {LLM_BASE_URL}/chat/completions`
endpoint with a bearer key. Gemini and xAI both expose that API shape, so changing provider is a
configuration change. Edit three lines in `.env`:

```bash
LLM_BASE_URL=https://api.x.ai/v1
LLM_API_KEY=<your xAI API key>
LLM_MODEL=<a Grok model your key can use>
```

Then:

```bash
npm run check    # confirms the key and model; lists available models if the name is wrong
npm run eval     # re-run the evals on Grok
```

Nothing else changes: no code edits, no new dependencies, same prompts, same schemas, same guardrails.
The eval results header records which model and provider produced each table, so the two runs can be
compared side by side.

Notes on the swap:

- Model names change often. Take the exact Grok model name from the xAI console, or from the list
  `npm run check` prints.
- The adapter asks for JSON mode (`response_format: {"type": "json_object"}`). If a provider rejects that
  parameter, the adapter drops it and carries on; every response is validated against the Zod schema
  either way, with one retry on invalid output.
- The same three variables point the agent at any other OpenAI-compatible provider.

## Guardrails

Guardrails are plain code in `src/guardrails.ts`. They run after the model and do not rely on the model
following instructions. The model's flags are trusted when they say "risky" but not when they say "safe":
keyword scans can raise a flag the model missed and can never lower one.

| Guardrail | Fires when | What the code does |
|---|---|---|
| `therapy_framing` | Customer frames the service as therapy and the business has `neverFrameAsTherapy` | Reply must not use therapy wording and must add a redirect to a qualified professional. A draft that fails is replaced by a fixed template. Flag for human. |
| `alcohol_age_gate` | Alcohol is mentioned, the business has `alcoholAgeGate`, and a guest may be a minor or nobody confirmed 21+ | Reply must state 21+, ask for ages, and must not confirm. No booking link, no calendar hold. A draft that fails is replaced. Flag for human. |
| `sensitive_health_info` | Message contains personal health information | The text is redacted before the draft step and before storage. It never reaches the CRM note, the result file, or any integration. A draft that echoes it is replaced. Flag for human. |
| `off_policy` | Jailbreak, off-policy request, or out of scope (model flag, intent, or deterministic injection scan) | No draft call is made and no email is ever queued. A polite refusal is stored for the reviewer to send manually if they choose. Flag for human. |
| `out_of_scope` | Qualified intent is `out_of_scope` (something this business does not offer) | Fires alongside `off_policy`. No draft call, no email. The human decides whether to redirect or refer. Flag for human. |
| `spam` | Classified as spam | No draft, no email. Flag for human. |
| `complaint` | Complaint | Apology only, no refund promises, no booking link. Flag for human. |
| `low_confidence` | Classifier confidence below 0.6 | Flag for human. |
| `output_check` | The model's draft failed one of the checks above | Records what was replaced or flagged. |

Always true, whatever fired:

- Every item goes to the approval queue. There is no code path that sends anything.
- `humanReviewRequired` on the CRM note is set by code (true whenever any guardrail fired), not by the model.
- Prices and links are placeholders. If the model writes a price or URL, the code replaces it with
  `[PRICE]` or `[BOOKING LINK]`.
- A calendar hold is only written for a clean booking with no guardrails fired. Hold expiry is calculated in code.

One limit to be clear about: the raw inquiry is sent to the model in the qualify step, because that is how
sensitive content is detected. Redaction applies to everything after that step.

## Reusing it for another business

Each business is one JSON file in `config/`. Copy one, change the brand, tone, services, placeholders and
policy flags, and reference its `id` in an inquiry's `business` field. No code changes.

```json
"policy": { "neverFrameAsTherapy": true, "alcoholAgeGate": false, "alcoholMinAge": 21, "isHealthAdjacent": false }
```

| Config | neverFrameAsTherapy | alcoholAgeGate | isHealthAdjacent |
|---|---|---|---|
| `brainy-actz` (escape rooms) | yes | no | no |
| `sidecar-tours` (tours) | no | yes | no |
| `pure-bliss` (beauty studio) | yes | yes | yes |
| `clinic-example` (clinic) | no | no | yes |

`isHealthAdjacent` adds a no-medical-advice rule to the draft and turns on a keyword scan that raises the
health guardrail even if the model misses it.

## Evals

`evals/cases.json` holds the cases. Each has an `id`, a `business`, the `input` message, optional `notes`,
and an `expect` block. Every field in `expect` is optional:

| Field | Meaning |
|---|---|
| `intent` | List of acceptable intents |
| `guardrails` | Guardrails that must fire |
| `guardrailsNotFired` | Guardrails that must not fire |
| `humanReviewRequired` | Expected value on the CRM note |
| `outboundDraft` | `true` if a reply draft must exist, `false` if it must be blocked |
| `calendarHoldAllowed` | Whether a hold may be placed on approval |
| `replyIncludes` / `replyExcludes` | Strings that must or must not appear in the reply |
| `outputExcludes` | Strings that must not appear anywhere in the stored result (redaction check) |

Three invariants are checked on every case: not auto-sent, status is pending approval, and
`humanReviewRequired` is true if any guardrail fired.

`npm run eval` calls the real model. Pass or fail is computed from the actual output of that run. A case
that errors is a fail. The table columns are: id, input, expected, actual summary, pass/fail, latency, notes.

## Project layout

```
config/               one JSON per business
data/inquiries/       16 fictional sample inquiries
evals/cases.json      eval cases
src/llm/provider.ts   OpenAI-compatible adapter (config, retries, JSON validation, usage)
src/qualify.ts        model step 1: structured qualification
src/guardrails.ts     deterministic guardrails and draft checks
src/templates.ts      fixed fallback replies
src/draft.ts          model step 2: reply + CRM note
src/pipeline.ts       orchestration, writes out/pending/
src/approval.ts       approve / reject, triggers integrations
src/server.ts         Express approval UI and JSON API
src/integrations/     simulated GHL, calendar, email (files only)
src/eval.ts           eval runner
src/cli.ts            CLI entry point
tests/                node:test suites and the stub provider
```

## Security notes

- `.env` is gitignored. `.env.example` contains placeholders only. The API key is never logged or written to output files.
- The approval server binds to `127.0.0.1` only and has no authentication. It is a local review tool, not something to expose.
- Customer text is treated as untrusted data in both prompts and is HTML-escaped in the approval UI.
