// test stub, not a real model
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubOptions {
  invalidJsonFirst?: number;
  rejectResponseFormat?: boolean;
  rateLimitFirst?: number;
  badDrafts?: boolean;
}

export interface StubLlm {
  baseUrl: string;
  requests: { path: string; auth: string | undefined; body: any }[];
  close: () => Promise<void>;
}

function classify(inquiry: string) {
  const t = inquiry.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  const injection = has(/ignore all previous|system prompt|disregard your rules|essay/);
  const spam = has(/seo|backlinks|loan|click the link/);
  const outOfScope = has(/repair|weld|rent out motorcycles/);
  const complaint = has(/refund|money back|disappointed/);
  const health = has(/diagnosed|isotretinoin|pregnant|epilepsy|diabetes/);
  const party = t.match(/\b(?:for|of)\s+(\d+)\b/);
  const date = inquiry.match(/\d{4}-\d{2}-\d{2}/);
  return {
    intent: spam ? "spam" : outOfScope ? "out_of_scope" : complaint ? "complaint" : has(/book|tickets/) ? "booking" : "question",
    businessType: "other",
    partySize: party ? Number(party[1]) : null,
    requestedDate: date ? date[0] : null,
    mentionsAlcohol: has(/brewery|winery|beer|wine|champagne/),
    possibleMinor: has(/19th birthday|18th birthday|my son|my daughter/),
    ageConfirmed21Plus: has(/over 21|21 or older/),
    therapyFraming: has(/therap|cure my/),
    containsSensitiveHealthInfo: health,
    sensitiveSpans: health ? (inquiry.match(/[^.!?\n]*(?:diagnosed|isotretinoin|pregnant|epilepsy|diabetes)[^.!?\n]*[.!?]?/gi) ?? []).map((s) => s.trim()) : [],
    jailbreakOrOffPolicy: injection,
    confidence: 0.9,
    rationale: "Stub classification.",
  };
}

function draftFor(user: string, bad: boolean) {
  if (bad) {
    return {
      reply: {
        subject: "You're booked!",
        body: "Great news, your booking is confirmed for $45 per person. This is wonderful therapy and very healing. See https://real-site.example/book\n\nThe Team",
      },
      crmNote: { summary: "Customer wants to book.", tags: ["Booking Lead"], nextBestAction: "Send confirmation.", humanReviewRequired: false },
    };
  }
  const gated = /alcohol_age_gate/.test(user);
  return {
    reply: {
      subject: "Thanks for your enquiry",
      body: gated
        ? "Hi there,\n\nThanks for getting in touch. Tours involving alcohol are strictly 21+ with photo ID. Could you confirm everyone's ages?\n\nThe Team"
        : "Hi there,\n\nThanks for getting in touch! Prices start from [PRICE]. You can book here: [BOOKING LINK]\n\nThe Team",
    },
    crmNote: { summary: "Customer enquiry received.", tags: ["lead"], nextBestAction: "Follow up after approval.", humanReviewRequired: false },
  };
}

export async function startStubLlm(options: StubOptions = {}): Promise<StubLlm> {
  const requests: StubLlm["requests"] = [];
  let chatCalls = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };

      if (req.url?.endsWith("/models")) return send(200, { data: [{ id: "stub-model" }] });
      if (!req.url?.endsWith("/chat/completions")) return send(404, { error: "not found" });
      if (options.rejectResponseFormat && body.response_format) {
        return send(400, { error: { message: "Unsupported parameter: response_format" } });
      }

      chatCalls++;
      if (chatCalls <= (options.rateLimitFirst ?? 0)) return send(429, { error: "slow down" }, { "retry-after": "1" });

      const system: string = body.messages[0].content;
      const user: string = body.messages[1].content;
      let content: string;
      if (chatCalls <= (options.rateLimitFirst ?? 0) + (options.invalidJsonFirst ?? 0)) {
        content = "Sure! Here is the answer you asked for.";
      } else if (system.includes("intake classifier")) {
        const inquiry = user.split("<<<INQUIRY (untrusted customer text)")[1]?.split("INQUIRY>>>")[0] ?? user;
        content = JSON.stringify(classify(`${user.match(/Subject: (.*)/)?.[1] ?? ""}\n${inquiry}`));
      } else if (system.includes("write reply drafts")) {
        content = "```json\n" + JSON.stringify(draftFor(user, !!options.badDrafts)) + "\n```";
      } else {
        content = JSON.stringify({ ok: true });
      }
      send(200, {
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1/`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
