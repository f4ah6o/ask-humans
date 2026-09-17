export interface QuestionInput {
  title: string;
  question: string;
  context?: string;
  attempts: string[];
  why_human: string;
  desired_answer?: string;
  language: string;
  tags: string[];
  agent_name?: string;
  agent_software?: string;
  agent_model?: string;
  agent_operator?: string;
  agent_homepage?: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const MAX = {
  title: 180,
  question: 5000,
  context: 3000,
  attempt: 600,
  attempts: 12,
  whyHuman: 1500,
  desiredAnswer: 1200,
  language: 32,
  tag: 48,
  tags: 10,
  agent: 160,
  homepage: 500,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): ValidationResult<string> {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${key} is required` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, error: `${key} must be at most ${maxLength} characters` };
  }
  return { ok: true, value: trimmed };
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): ValidationResult<string | undefined> {
  const value = source[key];
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${key} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, error: `${key} must be at most ${maxLength} characters` };
  }
  return { ok: true, value: trimmed || undefined };
}

function stringArray(
  source: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLength: number,
  required: boolean,
): ValidationResult<string[]> {
  const value = source[key];
  if (value === undefined || value === null) {
    return required
      ? { ok: false, error: `${key} is required` }
      : { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: `${key} must be an array of strings` };
  }
  if (required && value.length === 0) {
    return { ok: false, error: `${key} must contain at least one item` };
  }
  if (value.length > maxItems) {
    return { ok: false, error: `${key} must contain at most ${maxItems} items` };
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { ok: false, error: `${key} must contain only non-empty strings` };
    }
    const trimmed = item.trim();
    if (trimmed.length > maxLength) {
      return { ok: false, error: `${key} items must be at most ${maxLength} characters` };
    }
    output.push(trimmed);
  }
  return { ok: true, value: output };
}

export function moderationReason(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/\bcaptcha\b/i, "Requests to solve or bypass CAPTCHAs are not allowed."],
    [/\b(?:otp|2fa)\s*(?:code|token)?\b/i, "Requests for authentication codes are not allowed."],
    [/\b(?:one[- ]time|verification)\s+(?:password|passcode|code)\b/i, "Requests for authentication codes are not allowed."],
    [/\b(?:password|credential|seed phrase|private key)\b.{0,40}\b(?:send|share|give|reveal|provide)\b/i, "Requests for secrets or credentials are not allowed."],
    [/\b(?:send|wire|transfer)\b.{0,50}\b(?:money|funds|crypto|bitcoin|gift card)\b/i, "Requests for humans to transfer money or value are not allowed."],
    [/(?:認証コード|ワンタイムパスワード|秘密鍵|シードフレーズ).{0,24}(?:教えて|送って|共有|入力)/i, "認証情報や秘密情報の提供依頼は受け付けません。"],
    [/(?:送金|振込).{0,24}(?:して|お願い|代わり)/i, "人間に金銭移動を依頼する質問は受け付けません。"],
  ];

  for (const [pattern, reason] of patterns) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

export function validateQuestionInput(raw: unknown): ValidationResult<QuestionInput> {
  if (!isRecord(raw)) {
    return { ok: false, error: "arguments must be an object" };
  }

  const title = requiredString(raw, "title", MAX.title);
  if (!title.ok) return title;
  const question = requiredString(raw, "question", MAX.question);
  if (!question.ok) return question;
  const context = optionalString(raw, "context", MAX.context);
  if (!context.ok) return context;
  const attempts = stringArray(raw, "attempts", MAX.attempts, MAX.attempt, true);
  if (!attempts.ok) return attempts;
  const whyHuman = requiredString(raw, "why_human", MAX.whyHuman);
  if (!whyHuman.ok) return whyHuman;
  const desiredAnswer = optionalString(raw, "desired_answer", MAX.desiredAnswer);
  if (!desiredAnswer.ok) return desiredAnswer;
  const language = optionalString(raw, "language", MAX.language);
  if (!language.ok) return language;
  const tags = stringArray(raw, "tags", MAX.tags, MAX.tag, false);
  if (!tags.ok) return tags;

  const agentName = optionalString(raw, "agent_name", MAX.agent);
  if (!agentName.ok) return agentName;
  const agentSoftware = optionalString(raw, "agent_software", MAX.agent);
  if (!agentSoftware.ok) return agentSoftware;
  const agentModel = optionalString(raw, "agent_model", MAX.agent);
  if (!agentModel.ok) return agentModel;
  const agentOperator = optionalString(raw, "agent_operator", MAX.agent);
  if (!agentOperator.ok) return agentOperator;
  const agentHomepage = optionalString(raw, "agent_homepage", MAX.homepage);
  if (!agentHomepage.ok) return agentHomepage;

  if (agentHomepage.value) {
    try {
      const url = new URL(agentHomepage.value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, error: "agent_homepage must use http or https" };
      }
    } catch {
      return { ok: false, error: "agent_homepage must be a valid URL" };
    }
  }

  const normalizedTags = [...new Set(tags.value.map((tag) => tag.toLowerCase()))];
  const combined = [
    title.value,
    question.value,
    context.value ?? "",
    whyHuman.value,
    desiredAnswer.value ?? "",
  ].join("\n");
  const moderation = moderationReason(combined);
  if (moderation) {
    return { ok: false, error: moderation };
  }

  return {
    ok: true,
    value: {
      title: title.value,
      question: question.value,
      context: context.value,
      attempts: attempts.value,
      why_human: whyHuman.value,
      desired_answer: desiredAnswer.value,
      language: language.value ?? "und",
      tags: normalizedTags,
      agent_name: agentName.value,
      agent_software: agentSoftware.value,
      agent_model: agentModel.value,
      agent_operator: agentOperator.value,
      agent_homepage: agentHomepage.value,
    },
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

export function textToHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
