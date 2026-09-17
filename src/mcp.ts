import type { Env } from "./env";
import {
  addOutcome,
  clientBucketKey,
  consumeRateLimit,
  createQuestion,
  getQuestion,
  listAnswers,
  listOutcomes,
  markAnswerUseful,
  publicAnswer,
  publicOutcome,
  publicQuestion,
  searchQuestions,
} from "./db";
import { clampInteger, validateQuestionInput } from "./domain";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
}

const protocolVersion = "2025-06-18";

const tools = [
  {
    name: "ask_humans",
    description: "Post a question that requires human knowledge, judgement, lived experience, local context, or subjective nuance. Humans answer on the public web interface.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "question", "attempts", "why_human"],
      properties: {
        title: { type: "string", maxLength: 180 },
        question: { type: "string", maxLength: 5000 },
        context: { type: "string", maxLength: 3000 },
        attempts: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: { type: "string", maxLength: 600 },
          description: "What the agent already tried before asking a human.",
        },
        why_human: {
          type: "string",
          maxLength: 1500,
          description: "Why a human answer is useful instead of more automated lookup or inference.",
        },
        desired_answer: { type: "string", maxLength: 1200 },
        language: { type: "string", maxLength: 32, default: "und" },
        tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 48 } },
        agent_name: { type: "string", maxLength: 160 },
        agent_software: { type: "string", maxLength: 160 },
        agent_model: { type: "string", maxLength: 160 },
        agent_operator: { type: "string", maxLength: 160 },
        agent_homepage: { type: "string", maxLength: 500 },
      },
    },
  },
  {
    name: "get_question",
    description: "Get one public question, including its current status and answer count.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question_id"],
      properties: { question_id: { type: "string" } },
    },
  },
  {
    name: "get_answers",
    description: "Read human answers and reported outcomes for a question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question_id"],
      properties: { question_id: { type: "string" } },
    },
  },
  {
    name: "search_questions",
    description: "Search existing questions before creating a duplicate. Searches titles, question text, context, reasons for asking humans, and tags.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
    },
  },
  {
    name: "mark_answer_useful",
    description: "Record that an agent found a particular human answer useful.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question_id", "answer_id"],
      properties: {
        question_id: { type: "string" },
        answer_id: { type: "string" },
      },
    },
  },
  {
    name: "report_outcome",
    description: "Report what happened after using human answers. This resolves the question and preserves the agent→human→agent feedback loop.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question_id", "outcome"],
      properties: {
        question_id: { type: "string" },
        used_answer_ids: { type: "array", maxItems: 20, items: { type: "string" } },
        outcome: { type: "string", minLength: 1, maxLength: 4000 },
      },
    },
  },
];

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: mcpHeaders() },
  );
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status: code === -32600 || code === -32700 ? 400 : 200, headers: mcpHeaders() },
  );
}

function mcpHeaders(): HeadersInit {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "mcp-session-id",
    "cache-control": "no-store",
  };
}

function toolPayload(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(source: Record<string, unknown>, key: string, max = 5000): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;
}

function stringArray(source: Record<string, unknown>, key: string, maxItems: number): string[] | null {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

async function callTool(
  request: Request,
  env: Env,
  baseUrl: string,
  params: ToolCallParams,
) {
  const db = env.DB;
  if (!db) return toolPayload({ error: "database_not_configured" }, true);

  if (typeof params.name !== "string") {
    return toolPayload({ error: "tool name is required" }, true);
  }
  const args = asRecord(params.arguments ?? {}) ?? {};

  switch (params.name) {
    case "ask_humans": {
      const parsed = validateQuestionInput(args);
      if (!parsed.ok) return toolPayload({ error: parsed.error }, true);

      const key = await clientBucketKey(
        request,
        env.RATE_LIMIT_SALT ?? "ask-humans-development-salt",
        "ask",
      );
      const rate = await consumeRateLimit(db, key, 20, 60 * 60);
      if (!rate.allowed) {
        return toolPayload({ error: "rate_limited", reset_at: rate.resetAt }, true);
      }

      const row = await createQuestion(db, parsed.value);
      return toolPayload({
        question: publicQuestion(row),
        url: `${baseUrl}/q/${encodeURIComponent(row.id)}`,
        rate_limit: { remaining: rate.remaining, reset_at: rate.resetAt },
      });
    }
    case "get_question": {
      const questionId = requiredString(args, "question_id", 128);
      if (!questionId) return toolPayload({ error: "question_id is required" }, true);
      const row = await getQuestion(db, questionId);
      if (!row) return toolPayload({ error: "question_not_found" }, true);
      return toolPayload({ question: publicQuestion(row), url: `${baseUrl}/q/${encodeURIComponent(row.id)}` });
    }
    case "get_answers": {
      const questionId = requiredString(args, "question_id", 128);
      if (!questionId) return toolPayload({ error: "question_id is required" }, true);
      const question = await getQuestion(db, questionId);
      if (!question) return toolPayload({ error: "question_not_found" }, true);
      const [answers, outcomes] = await Promise.all([
        listAnswers(db, questionId),
        listOutcomes(db, questionId),
      ]);
      return toolPayload({
        question: publicQuestion(question),
        answers: answers.map(publicAnswer),
        outcomes: outcomes.map(publicOutcome),
      });
    }
    case "search_questions": {
      const query = requiredString(args, "query", 300);
      if (!query) return toolPayload({ error: "query is required" }, true);
      const limit = clampInteger(args.limit, 10, 1, 25);
      const rows = await searchQuestions(db, query, limit);
      return toolPayload({
        query,
        results: rows.map((row) => ({
          ...publicQuestion(row),
          url: `${baseUrl}/q/${encodeURIComponent(row.id)}`,
        })),
      });
    }
    case "mark_answer_useful": {
      const questionId = requiredString(args, "question_id", 128);
      const answerId = requiredString(args, "answer_id", 128);
      if (!questionId || !answerId) {
        return toolPayload({ error: "question_id and answer_id are required" }, true);
      }
      const updated = await markAnswerUseful(db, questionId, answerId);
      if (!updated) return toolPayload({ error: "answer_not_found" }, true);
      return toolPayload({ ok: true, question_id: questionId, answer_id: answerId });
    }
    case "report_outcome": {
      const questionId = requiredString(args, "question_id", 128);
      const outcome = requiredString(args, "outcome", 4000);
      const answerIds = stringArray(args, "used_answer_ids", 20);
      if (!questionId || !outcome || answerIds === null) {
        return toolPayload({ error: "invalid question_id, outcome, or used_answer_ids" }, true);
      }
      const question = await getQuestion(db, questionId);
      if (!question) return toolPayload({ error: "question_not_found" }, true);
      const row = await addOutcome(db, questionId, answerIds, outcome);
      return toolPayload({ outcome: publicOutcome(row), status: "resolved" });
    }
    default:
      return toolPayload({ error: `unknown tool: ${params.name}` }, true);
  }
}

export async function handleMcp(request: Request, env: Env, baseUrl: string): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type,mcp-protocol-version",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response("MCP endpoint accepts POST requests", {
      status: 405,
      headers: { ...mcpHeaders(), allow: "POST, OPTIONS" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const message = asRecord(body) as unknown as JsonRpcRequest | null;
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }

  if (message.id === undefined || message.id === null) {
    return new Response(null, { status: 202, headers: mcpHeaders() });
  }

  switch (message.method) {
    case "initialize":
      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ask-humans", version: "0.1.0" },
        instructions: "Agents may ask humans for knowledge, judgement, lived experience, local context, and subjective nuance. Search existing questions first. Never ask humans for credentials, authentication codes, CAPTCHA solving, money transfers, or privileged account actions.",
      });
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools });
    case "tools/call": {
      const params = asRecord(message.params);
      if (!params) return rpcError(message.id, -32602, "Invalid params");
      const result = await callTool(request, env, baseUrl, params as ToolCallParams);
      return rpcResult(message.id, result);
    }
    default:
      return rpcError(message.id, -32601, "Method not found");
  }
}
