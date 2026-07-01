CREATE TABLE IF NOT EXISTS questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_ts TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  expert_id TEXT,
  answered BOOLEAN DEFAULT FALSE,
  answer_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commitments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_ts TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  maker_id TEXT NOT NULL,
  promised_to_id TEXT,
  description TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed BOOLEAN DEFAULT FALSE,
  reminder_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable full-text search on questions
CREATE INDEX IF NOT EXISTS questions_fts ON questions USING gin(to_tsvector('english', question_text));
