import { z } from "zod";

export const INTENTS = ["booking", "question", "complaint", "spam", "out_of_scope"] as const;
export const BUSINESS_TYPES = ["escape_room", "tour", "beauty_studio", "clinic", "other"] as const;

export const BusinessConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  brandName: z.string().min(1),
  businessType: z.enum(BUSINESS_TYPES),
  description: z.string().min(1),
  services: z.array(z.string()).min(1),
  experienceNoun: z.string().min(1),
  tone: z.string().min(1),
  signoff: z.string().min(1),
  placeholders: z.object({
    ghlLocation: z.string().min(1),
    bookingLink: z.string().min(1),
    price: z.string().min(1),
  }),
  policy: z.object({
    neverFrameAsTherapy: z.boolean(),
    alcoholAgeGate: z.boolean(),
    alcoholMinAge: z.number().int().positive().default(21),
    isHealthAdjacent: z.boolean(),
  }),
  extraForbiddenTerms: z.array(z.string()).default([]),
  defaultHoldMinutes: z.number().int().positive().default(60),
});
export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;

export const InquirySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase letters, digits and dashes"),
  business: z.string().min(1),
  channel: z.string().default("web_form"),
  receivedAt: z.string().min(1),
  from: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  subject: z.string().optional(),
  message: z.string().min(1),
});
export type Inquiry = z.infer<typeof InquirySchema>;

export const QualificationSchema = z.object({
  intent: z.enum(INTENTS),
  businessType: z.enum(BUSINESS_TYPES),
  partySize: z.number().int().positive().nullable(),
  requestedDate: z.string().nullable(),
  mentionsAlcohol: z.boolean(),
  possibleMinor: z.boolean(),
  ageConfirmed21Plus: z.boolean(),
  therapyFraming: z.boolean(),
  containsSensitiveHealthInfo: z.boolean(),
  sensitiveSpans: z.array(z.string()),
  jailbreakOrOffPolicy: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type Qualification = z.infer<typeof QualificationSchema>;

export type StoredQualification = Omit<Qualification, "sensitiveSpans">;

export const DraftSchema = z.object({
  reply: z.object({
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  crmNote: z.object({
    summary: z.string().min(1),
    tags: z.array(z.string()),
    nextBestAction: z.string().min(1),
    humanReviewRequired: z.boolean(),
  }),
});
export type Draft = z.infer<typeof DraftSchema>;

export interface Reply {
  kind: "draft" | "none";
  source: "model" | "fallback_template" | "none";
  subject: string | null;
  body: string | null;
  suggestedRefusal?: string;
  notes: string[];
}

export interface CrmNote {
  summary: string;
  tags: string[];
  nextBestAction: string;
  humanReviewRequired: boolean;
}

export interface LlmCallRecord {
  step: string;
  model: string;
  attempts: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type GuardrailId =
  | "therapy_framing"
  | "alcohol_age_gate"
  | "sensitive_health_info"
  | "off_policy"
  | "out_of_scope"
  | "spam"
  | "complaint"
  | "low_confidence"
  | "output_check";

export interface GuardrailDecision {
  id: GuardrailId;
  source: "model" | "deterministic" | "model+deterministic" | "output_check";
  reason: string;
  actions: string[];
}

export interface GuardrailOutcome {
  decisions: GuardrailDecision[];
  fired: GuardrailId[];
  humanReviewRequired: boolean;
  outboundDraftAllowed: boolean;
  calendarHoldAllowed: boolean;
  draftInstructions: string[];
  redaction: { applied: boolean; wholeMessage: boolean; spanCount: number };
  approvalRequired: true;
  autoSend: false;
}

export interface PipelineResult {
  id: string;
  business: string;
  brandName: string;
  processedAt: string;
  status: "pending_approval";
  autoSent: false;
  inquiry: Inquiry & { redacted: boolean };
  qualification: StoredQualification;
  guardrails: GuardrailOutcome;
  reply: Reply;
  crmNote: CrmNote;
  llm: {
    provider: string;
    model: string;
    calls: LlmCallRecord[];
    totalTokens: number;
    totalLatencyMs: number;
  };
}

export interface ApprovalRecord {
  approvedBy: string;
  approvedAt: string;
  replyEdited: boolean;
}

export interface ApprovedResult extends Omit<PipelineResult, "status"> {
  status: "approved";
  approval: ApprovalRecord;
  integrations: Record<"ghl" | "calendar" | "email", { status: string; file: string }>;
}
