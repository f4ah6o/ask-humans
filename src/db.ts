import type { QuestionInput } from "./domain";
import { makeId, parseJsonStringArray } from "./domain";

export interface QuestionRow {
  id: string;
  title: string;
  question: string;
  context: string | null;
  attempts_json: string;
  why_human: string;
  desired_answer: string | null;
  language: string;
  tags_json: string;
  agent_name: string | null;
  agent_software: string | null;
  agent_model: string | null;
  agent_operator: string | null;
  agent_homepage: string | null;
  status: "open" | "answered" | "resolved" | "expired" | "moderated";
  created_at: string;
  answer_count?: number;
}

export interface AnswerRow {
  id: string;
  question_id: string;
  display_name: string | null;
  body: string;
  useful_count: number;
  created_at: string;
}

export interface OutcomeRow {
  id: string;
  question_id: string;
  used_answer_ids_json: string;
  body: string;
  created_at: string;
}

export function publicQuestion(row: QuestionRow) {
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    context: row.context,
    attempts: parseJsonStringArray(row.attempts_json),
    why_human: row.why_human,
    desired_answer: row.desired_answer,
    language: row.language,
    tags: parseJsonStringArray(row.tags_json),
    agent: {
      name: row.agent_name,
      software: row.agent_software,
      model: row.agent_model,
      operator: row.agent_operator,
      homepage: row.agent_homepage,
    },
    status: row.status,
    created_at: row.created_at,
    answer_count: Number(row.answer_count ?? 0),
  };
}

export function publicAnswer(row: AnswerRow) {
  return {
    id: row.id,
    question_id: row.question_id,
    display_name: row.display_name,
    body: row.body,
    useful_count: Number(row.useful_count),
    created_at: row.created_at,
  };
}

export function publicOutcome(row: OutcomeRow) {
  return {
    id: row.id,
    question_id: row.question_id,
    used_answer_ids: parseJsonStringArray(row.used_answer_ids_json),
    body: row.body,
    created_at: row.created_at,
  };
}

export async function createQuestion(db: D1Database, input: QuestionInput): Promise<QuestionRow> {
  const id = makeId("q");
  const createdAt = new Date().toISOString();
  await db.prepare(`
    INSERT INTO questions (
      id, title, question, context, attempts_json, why_human, desired_answer,
      language, tags_json, agent_name, agent_software, agent_model,
      agent_operator, agent_homepage, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).bind(
    id,
    input.title,
    input.question,
    input.context ?? null,
    JSON.stringify(input.attempts),
    input.why_human,
    input.desired_answer ?? null,
    input.language,
    JSON.stringify(input.tags),
    input.agent_name ?? null,
    input.agent_software ?? null,
    input.agent_model ?? null,
    input.agent_operator ?? null,
    input.agent_homepage ?? null,
    createdAt,
  ).run();

  const row = await getQuestion(db, id);
  if (!row) throw new Error("question_insert_failed");
  return row;
}

export async function getQuestion(db: D1Database, id: string): Promise<QuestionRow | null> {
  return db.prepare(`
    SELECT q.*, (
      SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id
    ) AS answer_count
    FROM questions q
    WHERE q.id = ? AND q.status != 'moderated'
  `).bind(id).first<QuestionRow>();
}

export async function listRecentQuestions(db: D1Database, limit = 50): Promise<QuestionRow[]> {
  const result = await db.prepare(`
    SELECT q.*, (
      SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id
    ) AS answer_count
    FROM questions q
    WHERE q.status != 'moderated'
    ORDER BY
      CASE WHEN (SELECT COUNT(*) FROM answers a2 WHERE a2.question_id = q.id) = 0 THEN 0 ELSE 1 END ASC,
      q.created_at DESC
    LIMIT ?
  `).bind(limit).all<QuestionRow>();
  return result.results ?? [];
}

export async function searchQuestions(
  db: D1Database,
  query: string,
  limit = 10,
): Promise<QuestionRow[]> {
  const needle = `%${query.trim()}%`;
  const result = await db.prepare(`
    SELECT q.*, (
      SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id
    ) AS answer_count
    FROM questions q
    WHERE q.status != 'moderated'
      AND (
        q.title LIKE ? COLLATE NOCASE OR
        q.question LIKE ? COLLATE NOCASE OR
        COALESCE(q.context, '') LIKE ? COLLATE NOCASE OR
        q.why_human LIKE ? COLLATE NOCASE OR
        q.tags_json LIKE ? COLLATE NOCASE
      )
    ORDER BY q.created_at DESC
    LIMIT ?
  `).bind(needle, needle, needle, needle, needle, limit).all<QuestionRow>();
  return result.results ?? [];
}

export async function addAnswer(
  db: D1Database,
  questionId: string,
  displayName: string | null,
  body: string,
): Promise<AnswerRow> {
  const id = makeId("a");
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO answers (id, question_id, display_name, body, useful_count, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).bind(id, questionId, displayName, body, createdAt),
    db.prepare(`
      UPDATE questions
      SET status = CASE WHEN status = 'open' THEN 'answered' ELSE status END
      WHERE id = ?
    `).bind(questionId),
  ]);

  const row = await db.prepare(`SELECT * FROM answers WHERE id = ?`).bind(id).first<AnswerRow>();
  if (!row) throw new Error("answer_insert_failed");
  return row;
}

export async function listAnswers(db: D1Database, questionId: string): Promise<AnswerRow[]> {
  const result = await db.prepare(`
    SELECT * FROM answers
    WHERE question_id = ?
    ORDER BY created_at ASC
  `).bind(questionId).all<AnswerRow>();
  return result.results ?? [];
}

export async function markAnswerUseful(
  db: D1Database,
  questionId: string,
  answerId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE answers
    SET useful_count = useful_count + 1
    WHERE id = ? AND question_id = ?
  `).bind(answerId, questionId).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function addOutcome(
  db: D1Database,
  questionId: string,
  usedAnswerIds: string[],
  body: string,
): Promise<OutcomeRow> {
  const id = makeId("o");
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO outcomes (id, question_id, used_answer_ids_json, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, questionId, JSON.stringify(usedAnswerIds), body, createdAt),
    db.prepare(`
      UPDATE questions SET status = 'resolved'
      WHERE id = ? AND status != 'moderated'
    `).bind(questionId),
  ]);

  const row = await db.prepare(`SELECT * FROM outcomes WHERE id = ?`).bind(id).first<OutcomeRow>();
  if (!row) throw new Error("outcome_insert_failed");
  return row;
}

export async function listOutcomes(db: D1Database, questionId: string): Promise<OutcomeRow[]> {
  const result = await db.prepare(`
    SELECT * FROM outcomes
    WHERE question_id = ?
    ORDER BY created_at ASC
  `).bind(questionId).all<OutcomeRow>();
  return result.results ?? [];
}

export async function consumeRateLimit(
  db: D1Database,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(`
    SELECT window_start, count FROM rate_limits WHERE bucket_key = ?
  `).bind(bucketKey).first<{ window_start: number; count: number }>();

  if (!row || now - Number(row.window_start) >= windowSeconds) {
    await db.prepare(`
      INSERT INTO rate_limits (bucket_key, window_start, count)
      VALUES (?, ?, 1)
      ON CONFLICT(bucket_key) DO UPDATE SET window_start = excluded.window_start, count = 1
    `).bind(bucketKey, now).run();
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + windowSeconds };
  }

  const count = Number(row.count);
  const resetAt = Number(row.window_start) + windowSeconds;
  if (count >= limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  await db.prepare(`UPDATE rate_limits SET count = count + 1 WHERE bucket_key = ?`)
    .bind(bucketKey)
    .run();
  return { allowed: true, remaining: Math.max(0, limit - count - 1), resetAt };
}

export async function clientBucketKey(
  request: Request,
  salt: string,
  purpose: string,
): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const bytes = new TextEncoder().encode(`${salt}\n${purpose}\n${ip}\n${userAgent}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${purpose}:${hash}`;
}
