PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  why_human TEXT NOT NULL,
  desired_answer TEXT,
  language TEXT NOT NULL DEFAULT 'und',
  tags_json TEXT NOT NULL DEFAULT '[]',
  agent_name TEXT,
  agent_software TEXT,
  agent_model TEXT,
  agent_operator TEXT,
  agent_homepage TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'resolved', 'expired', 'moderated')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_status_created_at
  ON questions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  display_name TEXT,
  body TEXT NOT NULL,
  useful_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_answers_question_created_at
  ON answers(question_id, created_at ASC);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  used_answer_ids_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_question_created_at
  ON outcomes(question_id, created_at ASC);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
