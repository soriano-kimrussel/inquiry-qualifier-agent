// runs after the model, plain code only
import { alcoholGateReply, healthPrivacyReply, politeRefusal, therapyRedirectReply } from "./templates.js";
import type {
  BusinessConfig,
  CrmNote,
  Draft,
  GuardrailDecision,
  GuardrailId,
  GuardrailOutcome,
  Inquiry,
  Qualification,
  Reply,
  StoredQualification,
} from "./types.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.6;
const REDACTED = "[REDACTED]";

const INJECTION_RE =
  /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|your\s+|the\s+|of\s+)*(?:previous\s+|prior\s+|above\s+|earlier\s+)?(?:instructions|rules|prompts?|guidelines)|system\s+prompt|developer\s+mode|jailbreak|reveal\s+your\s+(?:prompt|instructions)|pretend\s+(?:you\s+are|to\s+be)/i;

const ALCOHOL_RE =
  /\b(?:alcohol\w*|beers?|wines?|winer(?:y|ies)|brewer(?:y|ies)|champagne|prosecco|mimosas?|cocktails?|booze|liquor|tequila|whiske?y|vodka|margaritas?|drinks|drinking|byob|bubbly|(?:pub|bar)\s+crawl|tasting)\b/i;

const MINOR_RE =
  /\b(?:1[0-9]|20|[5-9])\s*-?\s*(?:years?[- ]old|yrs?[- ]old|yo|y\/o)\b|\b(?:1[0-9]|20)th\s+birthday\b|\bteen(?:s|agers?)?\b|\bhigh[- ]school(?:ers?)?\b|\bminors?\b|\bunder\s?(?:age|21|18)\b|\b(?:my|our|the)\s+(?:kids?|children|child|son|daughter)\b/i;

const HEALTH_RE =
  /\b(?:diagnos\w*|medications?|prescri\w*|surgery|chemo\w*|cancer|diabet\w*|epilep\w*|seizures?|pregnan\w*|hiv|depress\w*|anxiety|ptsd|bipolar|eczema|psoriasis|rosacea|lupus|allerg\w*|asthma|heart\s+condition|pacemaker|blood\s+pressure|blood\s+thinners?|disorder|medical\s+condition|panic\s+attacks?|claustrophob\w*|miscarriage|accutane|isotretinoin|mental\s+health|autis\w*|adhd)\b/i;

const DEFAULT_THERAPY_TERMS = ["therap\\w*", "heal(?:s|ing|ed)?", "cures?", "cured", "rehab\\w*", "clinically", "mental\\s+health"];
const CONFIRMATION_RE = /\b(?:is|are|been|now)\s+(?:confirmed|booked|reserved)\b|\byou(?:'re| are)\s+(?:all\s+)?(?:set|booked|confirmed)\b|\bbooking\s+confirmed\b/i;
const PRICE_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|dollars|bucks)\b)/gi;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function therapyTermsRe(config: BusinessConfig): RegExp {
  const extra = config.extraForbiddenTerms.map((t) => `${escapeRe(t)}s?`);
  return new RegExp(`\\b(?:${[...DEFAULT_THERAPY_TERMS, ...extra].join("|")})\\b`, "gi");
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildRedactor(spans: string[]): (text: string) => string {
  const unique = [...new Set(spans.map((s) => s.trim()).filter((s) => s.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return (text) => text;
  const re = new RegExp(unique.map((s) => escapeRe(s).replace(/\s+/g, "\\s+")).join("|"), "gi");
  return (text) => text.replace(re, REDACTED);
}

export interface GuardrailContext {
  outcome: GuardrailOutcome;
  safeInquiry: Inquiry & { redacted: boolean };
  effective: StoredQualification;
  redact: (text: string) => string;
}

export function applyGuardrails(inquiry: Inquiry, q: Qualification, config: BusinessConfig): GuardrailContext {
  const text = `${inquiry.subject ?? ""}\n${inquiry.message}`;
  const decisions: GuardrailDecision[] = [];
  const draftInstructions: string[] = [];
  const minAge = config.policy.alcoholMinAge;

  const source = (model: boolean, scan: boolean): GuardrailDecision["source"] =>
    model && scan ? "model+deterministic" : model ? "model" : "deterministic";

  // scans can add a flag, never clear one
  const injectionScan = INJECTION_RE.test(text);
  const alcoholScan = config.policy.alcoholAgeGate && ALCOHOL_RE.test(text);
  const minorScan = MINOR_RE.test(text);
  const healthScan = config.policy.isHealthAdjacent && HEALTH_RE.test(text);

  const mentionsAlcohol = q.mentionsAlcohol || alcoholScan;
  const possibleMinor = q.possibleMinor || minorScan;
  const containsHealth = q.containsSensitiveHealthInfo || healthScan;
  const offPolicy = q.jailbreakOrOffPolicy || injectionScan;

  if (offPolicy || q.intent === "out_of_scope") {
    decisions.push({
      id: "off_policy",
      source: source(q.jailbreakOrOffPolicy || q.intent === "out_of_scope", injectionScan),
      reason: offPolicy
        ? "Inquiry attempts to override instructions or asks for something outside policy."
        : "Inquiry is outside what this business offers.",
      actions: ["Refuse politely", "No outbound draft generated", "Route to human"],
    });
  }

  if (q.intent === "out_of_scope") {
    decisions.push({
      id: "out_of_scope",
      source: "model",
      reason: "Inquiry asks for something this business does not offer.",
      actions: ["No outbound draft generated", "Route to human to decide on a redirect or referral"],
    });
  }

  if (q.intent === "spam") {
    decisions.push({
      id: "spam",
      source: "model",
      reason: "Classified as spam / unsolicited sales.",
      actions: ["No outbound draft generated", "Route to human to confirm and discard"],
    });
  }

  if (config.policy.alcoholAgeGate && mentionsAlcohol && (possibleMinor || !q.ageConfirmed21Plus)) {
    decisions.push({
      id: "alcohol_age_gate",
      source: source(q.mentionsAlcohol, alcoholScan),
      reason: possibleMinor
        ? `Alcohol is involved and a guest may be under ${minAge}.`
        : `Alcohol is involved and the customer has not confirmed all guests are ${minAge}+.`,
      actions: ["Do not confirm the booking", `State the ${minAge}+ requirement`, "Ask for guest ages", "Flag for human"],
    });
    draftInstructions.push(
      `ALCOHOL AGE GATE: do NOT confirm, reserve, or imply this booking will go ahead, and do not include the booking link. ` +
        `State clearly that experiences involving alcohol are strictly ${minAge}+ with valid photo ID. ` +
        `Ask the customer to confirm the ages of everyone in the group. Say a team member will follow up.`,
    );
  }

  if (config.policy.neverFrameAsTherapy && q.therapyFraming) {
    decisions.push({
      id: "therapy_framing",
      source: "model",
      reason: "Customer frames the service as therapy or treatment; this business must never be presented that way.",
      actions: ["Reply must not frame the service as therapy", "Add a safe redirect to a qualified professional", "Flag for human"],
    });
    draftInstructions.push(
      `THERAPY FRAMING: the customer described this as therapy/treatment. Do not agree with or repeat that framing. ` +
        `Describe it only as a ${config.experienceNoun} for enjoyment. Make no health, wellbeing, or outcome claims. ` +
        `Add one kind sentence that for that kind of support a qualified professional is the right person to speak with.`,
    );
  }

  let redact: (t: string) => string = (t) => t;
  const redaction = { applied: false, wholeMessage: false, spanCount: 0 };
  let safeInquiry: Inquiry & { redacted: boolean } = { ...inquiry, redacted: false };
  if (containsHealth) {
    const lower = text.toLowerCase();
    const modelSpans = q.sensitiveSpans.filter((s) => s.trim().length >= 3 && lower.includes(s.trim().toLowerCase()));
    const keywordSentences = splitSentences(text).filter((s) => HEALTH_RE.test(s));
    const spans = [...modelSpans, ...keywordSentences];
    redaction.applied = true;
    redaction.spanCount = new Set(spans).size;
    if (spans.length === 0) {
      // can't find it, so hide the whole message
      redaction.wholeMessage = true;
      safeInquiry = {
        ...inquiry,
        subject: inquiry.subject ? REDACTED : undefined,
        message: "[REDACTED: message withheld because it contains sensitive health information]",
        redacted: true,
      };
      redact = buildRedactor(splitSentences(inquiry.message));
    } else {
      redact = buildRedactor(spans);
      safeInquiry = {
        ...inquiry,
        subject: inquiry.subject ? redact(inquiry.subject) : undefined,
        message: redact(inquiry.message),
        redacted: true,
      };
    }
    decisions.push({
      id: "sensitive_health_info",
      source: source(q.containsSensitiveHealthInfo, healthScan),
      reason: "Message contains personal health information.",
      actions: ["Redacted before drafting and storage", "Reply must not echo it", "Never passed to CRM, calendar, or email", "Route to human"],
    });
    draftInstructions.push(
      `SENSITIVE HEALTH INFO: parts of the message were redacted. Do not guess at, mention, or refer to any health or medical detail. ` +
        `Give no medical advice. Say a team member will follow up personally, and ask the customer not to send health details by email.`,
    );
  }

  if (q.intent === "complaint") {
    decisions.push({
      id: "complaint",
      source: "model",
      reason: "Customer complaint.",
      actions: ["Draft an apology only", "No refund or compensation promises", "Flag for human"],
    });
    draftInstructions.push(
      `COMPLAINT: apologise sincerely and acknowledge the experience. Do not admit liability, promise refunds, credits, or compensation, ` +
        `and do not include the booking link. Say a manager will personally follow up.`,
    );
  }
  if (q.confidence < LOW_CONFIDENCE_THRESHOLD) {
    decisions.push({
      id: "low_confidence",
      source: "model",
      reason: `Classifier confidence ${q.confidence.toFixed(2)} is below ${LOW_CONFIDENCE_THRESHOLD}.`,
      actions: ["Flag for human"],
    });
  }

  const fired = [...new Set(decisions.map((d) => d.id))];
  const outboundDraftAllowed = !fired.includes("off_policy") && !fired.includes("out_of_scope") && !fired.includes("spam");
  const outcome: GuardrailOutcome = {
    decisions,
    fired,
    humanReviewRequired: fired.length > 0,
    outboundDraftAllowed,
    // clean bookings only
    calendarHoldAllowed: q.intent === "booking" && fired.length === 0,
    draftInstructions,
    redaction,
    approvalRequired: true,
    autoSend: false,
  };

  const { sensitiveSpans: _dropped, ...rest } = q;
  const effective: StoredQualification = {
    ...rest,
    mentionsAlcohol,
    possibleMinor,
    containsSensitiveHealthInfo: containsHealth,
    jailbreakOrOffPolicy: offPolicy,
    requestedDate: q.requestedDate ? redact(q.requestedDate) : null,
    rationale: redact(q.rationale),
  };

  return { outcome, safeInquiry, effective, redact };
}

function withDecision(outcome: GuardrailOutcome, decision: GuardrailDecision): GuardrailOutcome {
  const decisions = [...outcome.decisions, decision];
  const fired = [...new Set(decisions.map((d) => d.id))];
  return { ...outcome, decisions, fired, humanReviewRequired: true, calendarHoldAllowed: false };
}

function guardrailTags(config: BusinessConfig, q: StoredQualification, fired: GuardrailId[]): string[] {
  const tags = [`business:${config.id}`, `intent:${q.intent}`, ...fired.map((id) => `guardrail:${id}`)];
  if (fired.length > 0) tags.push("needs-human-review");
  return tags;
}

const normaliseTag = (tag: string) =>
  tag.toLowerCase().trim().replace(/[^a-z0-9:]+/g, "-").replace(/^-+|-+$/g, "");

export function enforceDraft(
  draft: Draft,
  ctx: GuardrailContext,
  config: BusinessConfig,
): { reply: Reply; crmNote: CrmNote; outcome: GuardrailOutcome } {
  let outcome = ctx.outcome;
  const { safeInquiry, effective, redact } = ctx;
  const fired = (id: GuardrailId) => ctx.outcome.fired.includes(id);
  const notes: string[] = [];
  let subject = draft.reply.subject.trim();
  let body = draft.reply.body.trim();
  let source: Reply["source"] = "model";

  const replaceWith = (template: string, why: string) => {
    body = template;
    source = "fallback_template";
    notes.push(`Model draft replaced with fixed template: ${why}`);
    outcome = withDecision(outcome, {
      id: "output_check",
      source: "output_check",
      reason: `Model draft failed a guardrail check: ${why}`,
      actions: ["Draft replaced with fixed safe template"],
    });
  };

  if (fired("alcohol_age_gate")) {
    const statesAge = new RegExp(`\\b${config.policy.alcoholMinAge}\\b`).test(body);
    if (!statesAge) replaceWith(alcoholGateReply(safeInquiry, config), `reply did not state the ${config.policy.alcoholMinAge}+ requirement`);
    else if (CONFIRMATION_RE.test(body)) replaceWith(alcoholGateReply(safeInquiry, config), "reply appeared to confirm an age-gated booking");
  }

  if (config.policy.neverFrameAsTherapy) {
    const hits = [...new Set((`${subject}\n${body}`.match(therapyTermsRe(config)) ?? []).map((m) => m.toLowerCase()))];
    if (hits.length > 0) {
      if (fired("therapy_framing")) {
        replaceWith(therapyRedirectReply(safeInquiry, config), `reply used therapy/treatment language (${hits.join(", ")})`);
        subject = `Your enquiry to ${config.brandName}`;
      } else {
        outcome = withDecision(outcome, {
          id: "output_check",
          source: "output_check",
          reason: `Reply uses wording this business avoids (${hits.join(", ")}).`,
          actions: ["Flag for human to reword before sending"],
        });
      }
    }
  }

  // health goes last so its template wins
  if (fired("sensitive_health_info")) {
    const echoed = redact(body) !== body || redact(subject) !== subject || HEALTH_RE.test(`${subject}\n${body}`);
    if (echoed) {
      replaceWith(healthPrivacyReply(safeInquiry, config), "reply referred to health details");
      subject = `Your enquiry to ${config.brandName}`;
    }
  }

  if (PRICE_RE.test(body)) {
    body = body.replace(PRICE_RE, config.placeholders.price);
    notes.push(`A specific price in the draft was replaced with ${config.placeholders.price}.`);
  }
  PRICE_RE.lastIndex = 0;
  if (URL_RE.test(body)) {
    body = body.replace(URL_RE, config.placeholders.bookingLink);
    notes.push(`A URL in the draft was replaced with ${config.placeholders.bookingLink}.`);
  }
  URL_RE.lastIndex = 0;

  const wantsLink =
    (effective.intent === "booking" || effective.intent === "question") &&
    !fired("alcohol_age_gate") &&
    !fired("sensitive_health_info") &&
    !fired("complaint");
  if (wantsLink && !body.includes(config.placeholders.bookingLink)) {
    const line = `You can check availability and book here: ${config.placeholders.bookingLink}`;
    const paragraphs = body.split(/\n{2,}/);
    const last = paragraphs[paragraphs.length - 1] ?? "";
    if (paragraphs.length > 1 && last.length < 80) paragraphs.splice(paragraphs.length - 1, 0, line);
    else paragraphs.push(line);
    body = paragraphs.join("\n\n");
    notes.push(`${config.placeholders.bookingLink} was missing and has been added.`);
  }

  const modelTags = draft.crmNote.tags.map((t) => normaliseTag(redact(t))).filter((t) => t && !t.includes("redacted"));
  const crmNote: CrmNote = {
    summary: redact(draft.crmNote.summary),
    tags: [...new Set([...guardrailTags(config, effective, outcome.fired), ...modelTags])],
    nextBestAction: redact(draft.crmNote.nextBestAction),
    // code decides this, not the model
    humanReviewRequired: outcome.humanReviewRequired,
  };

  return { reply: { kind: "draft", source, subject, body, notes }, crmNote, outcome };
}

export function buildBlockedOutput(ctx: GuardrailContext, config: BusinessConfig): { reply: Reply; crmNote: CrmNote } {
  const { outcome, effective, safeInquiry } = ctx;
  const isSpam = outcome.fired.includes("spam") && !outcome.fired.includes("off_policy");
  const isOutOfScope = outcome.fired.includes("out_of_scope");
  const reasons = outcome.decisions.map((d) => d.reason).join(" ");
  return {
    reply: {
      kind: "none",
      source: "none",
      subject: null,
      body: null,
      suggestedRefusal: isSpam ? undefined : politeRefusal(safeInquiry, config),
      notes: ["No outbound draft: blocked by guardrails. Nothing will be queued for sending."],
    },
    crmNote: {
      summary: `No reply drafted. ${reasons}`,
      tags: guardrailTags(config, effective, outcome.fired),
      nextBestAction: isSpam
        ? "Human to confirm this is spam and discard."
        : isOutOfScope
          ? "Human to decide whether to redirect or refer the customer. The suggested polite refusal can be sent manually."
          : "Human to review. If a reply is warranted, send the suggested polite refusal manually.",
      humanReviewRequired: true,
    },
  };
}
