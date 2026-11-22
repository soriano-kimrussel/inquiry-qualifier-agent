import type { BusinessConfig, Inquiry } from "./types.js";

const firstName = (inquiry: Inquiry) => inquiry.from.name.trim().split(/\s+/)[0] || "there";

export function alcoholGateReply(inquiry: Inquiry, config: BusinessConfig): string {
  const age = config.policy.alcoholMinAge;
  return `Hi ${firstName(inquiry)},

Thanks for reaching out to ${config.brandName}! Before we can take this request any further: any experience that includes alcohol is strictly ${age}+, and every guest needs valid government-issued photo ID on the day.

Could you let us know the ages of everyone in your group, and whether all guests are ${age} or older?

Once we hear back, a member of our team will follow up with the next steps.

${config.signoff}`;
}

export function therapyRedirectReply(inquiry: Inquiry, config: BusinessConfig): string {
  const { bookingLink, price } = config.placeholders;
  return `Hi ${firstName(inquiry)},

Thanks for your interest in ${config.brandName}! To set the right expectations: what we offer is a ${config.experienceNoun}, purely for enjoyment. It is not a form of professional care and we can't make any health or wellbeing claims about it. For that kind of support, a qualified professional is the right person to speak with.

If you'd like to join us for the experience itself, you can see options here: ${bookingLink} (from ${price}).

${config.signoff}`;
}

export function healthPrivacyReply(inquiry: Inquiry, config: BusinessConfig): string {
  return `Hi ${firstName(inquiry)},

Thank you for getting in touch with ${config.brandName}. We've received your message, and a member of our team will follow up with you personally.

For your privacy, please don't send personal health details by email or web form. Our team can talk things through with you directly.

${config.signoff}`;
}

export function politeRefusal(inquiry: Inquiry, config: BusinessConfig): string {
  return `Hi ${firstName(inquiry)},

Thanks for your message. Unfortunately that isn't something ${config.brandName} can help with. If you have a question about ${config.services[0] ?? "our services"} or would like to make a booking, we'd be glad to help.

${config.signoff}`;
}
