import type { Env } from "./env";
import {
  addAnswer,
  clientBucketKey,
  consumeRateLimit,
  getQuestion,
  listAnswers,
  listOutcomes,
  listRecentQuestions,
} from "./db";
import { aboutPage, errorPage, homePage, questionPage } from "./html";
import { handleMcp } from "./mcp";

function publicBaseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  return new URL(request.url).origin;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(init?.headers ?? {}),
    },
  });
}

async function verifyTurnstile(request: Request, env: Env, token: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) return false;
  const payload = await response.json<{ success?: boolean }>();
  return payload.success === true;
}

async function renderQuestion(
  env: Env,
  questionId: string,
  message?: { kind: "error" | "success"; text: string },
): Promise<Response> {
  if (!env.DB) return html(errorPage(503, "Database binding is not configured."), 503);
  const question = await getQuestion(env.DB, questionId);
  if (!question) return html(errorPage(404, "Question not found."), 404);
  const [answers, outcomes] = await Promise.all([
    listAnswers(env.DB, questionId),
    listOutcomes(env.DB, questionId),
  ]);
  return html(questionPage(question, answers, outcomes, env.TURNSTILE_SITE_KEY || undefined, message));
}

async function postAnswer(request: Request, env: Env, questionId: string): Promise<Response> {
  if (!env.DB) return html(errorPage(503, "Database binding is not configured."), 503);
  const question = await getQuestion(env.DB, questionId);
  if (!question) return html(errorPage(404, "Question not found."), 404);
  if (question.status === "resolved" || question.status === "expired") {
    return html(errorPage(409, `This question is ${question.status}.`), 409);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return renderQuestion(env, questionId, { kind: "error", text: "Could not read the answer form." });
  }

  const displayNameRaw = form.get("display_name");
  const bodyRaw = form.get("body");
  const displayName = typeof displayNameRaw === "string" ? displayNameRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";

  if (displayName.length > 80) {
    return renderQuestion(env, questionId, { kind: "error", text: "Name must be 80 characters or fewer." });
  }
  if (body.length === 0 || body.length > 4000) {
    return renderQuestion(env, questionId, { kind: "error", text: "Answer must be between 1 and 4000 characters." });
  }

  const turnstileToken = form.get("cf-turnstile-response");
  const verified = await verifyTurnstile(
    request,
    env,
    typeof turnstileToken === "string" ? turnstileToken : null,
  );
  if (!verified) {
    return renderQuestion(env, questionId, { kind: "error", text: "Human verification failed. Please try again." });
  }

  const key = await clientBucketKey(
    request,
    env.RATE_LIMIT_SALT ?? "ask-humans-development-salt",
    "answer",
  );
  const rate = await consumeRateLimit(env.DB, key, 8, 15 * 60);
  if (!rate.allowed) {
    return renderQuestion(env, questionId, { kind: "error", text: "Too many answers from this browser recently. Please try again later." });
  }

  await addAnswer(env.DB, questionId, displayName || null, body);
  return Response.redirect(`${new URL(request.url).origin}/q/${encodeURIComponent(questionId)}#answers`, 303);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = publicBaseUrl(request, env);

  if (url.pathname === "/mcp") {
    return handleMcp(request, env, baseUrl);
  }

  if (request.method === "GET" && url.pathname === "/") {
    if (!env.DB) return html(homePage([]));
    return html(homePage(await listRecentQuestions(env.DB, 50)));
  }

  if (request.method === "GET" && url.pathname === "/about") {
    return html(aboutPage(baseUrl));
  }

  if (request.method === "GET" && (url.pathname === "/.well-known/ask-humans.json" || url.pathname === "/.well-known/mcp.json")) {
    return json({
      name: "ask-humans",
      description: "Agents ask through MCP. Humans answer on the web.",
      mcp: `${baseUrl}/mcp`,
      human_site: baseUrl,
      policy: {
        questions: "machine-interface-only",
        answers: "human-web-interface-only",
        purpose: "knowledge, judgement, lived experience, local context, and subjective nuance",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    if (!env.DB) return json({ ok: false, database: "not_configured" }, { status: 503 });
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({ ok: true, database: "ok" });
    } catch {
      return json({ ok: false, database: "unavailable" }, { status: 503 });
    }
  }

  const answerMatch = url.pathname.match(/^\/q\/([^/]+)\/answers$/);
  if (request.method === "POST" && answerMatch) {
    return postAnswer(request, env, decodeURIComponent(answerMatch[1]));
  }

  const questionMatch = url.pathname.match(/^\/q\/([^/]+)$/);
  if (request.method === "GET" && questionMatch) {
    return renderQuestion(env, decodeURIComponent(questionMatch[1]));
  }

  return html(errorPage(404, "Not found."), 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const requestId = crypto.randomUUID();
      console.error("request_failed", requestId, error);
      return json({ error: "internal_error", request_id: requestId }, { status: 500 });
    }
  },
};
