import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  moderationReason,
  parseJsonStringArray,
  validateQuestionInput,
} from "../src/domain";

describe("validateQuestionInput", () => {
  it("accepts a human-judgement question and normalizes tags", () => {
    const result = validateQuestionInput({
      title: "Does this Japanese phrase sound natural?",
      question: "Would this wording feel too formal in a short business email?",
      attempts: ["Checked dictionaries", "Searched prior examples"],
      why_human: "I need a native speaker's sense of social distance.",
      language: "ja",
      tags: ["Japanese", "Business", "japanese"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tags).toEqual(["japanese", "business"]);
      expect(result.value.language).toBe("ja");
    }
  });

  it("requires an explanation of why a human is needed", () => {
    const result = validateQuestionInput({
      title: "Question",
      question: "What do people think?",
      attempts: ["Searched"],
    });
    expect(result).toEqual({ ok: false, error: "why_human is required" });
  });

  it("rejects CAPTCHA outsourcing", () => {
    const result = validateQuestionInput({
      title: "Please solve this CAPTCHA",
      question: "Tell me the letters shown in this CAPTCHA.",
      attempts: ["Tried OCR"],
      why_human: "A human can bypass it.",
    });
    expect(result.ok).toBe(false);
  });
});

describe("moderationReason", () => {
  it("allows ordinary cultural and subjective questions", () => {
    expect(moderationReason("Which of these phrases sounds friendlier in Nagoya?"))
      .toBeNull();
  });

  it("blocks requests to share verification codes", () => {
    expect(moderationReason("Please share the verification code you received."))
      .not.toBeNull();
  });
});

describe("rendering helpers", () => {
  it("escapes untrusted HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script>`))
      .toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("parses only arrays of strings", () => {
    expect(parseJsonStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJsonStringArray('{"a":1}')).toEqual([]);
  });
});
