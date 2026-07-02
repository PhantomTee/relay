CREATE TABLE IF NOT EXISTS questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_ts TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  keywords JSONB DEFAULT '[]'::jsonb,
  embedding JSONB,
  answer_embedding JSONB,
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'routed', 'answered', 'expired')),
  expert_id TEXT,
  answered BOOLEAN DEFAULT FALSE,
  answer_text TEXT,
  route_after TIMESTAMPTZ,
  routed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
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

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT TRUE,
  configured_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_ts TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_ts, user_id, rating)
);

CREATE TABLE IF NOT EXISTS expert_scores (
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  score NUMERIC DEFAULT 0,
  answers_count INTEGER DEFAULT 0,
  positive_feedback_count INTEGER DEFAULT 0,
  negative_feedback_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, keyword)
);

CREATE TABLE IF NOT EXISTS slack_installations (
  team_id TEXT PRIMARY KEY,
  enterprise_id TEXT,
  bot_user_id TEXT,
  installed_by TEXT,
  installation JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns for older hackathon databases that were created before this schema grew.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS keywords JSONB DEFAULT '[]'::jsonb;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS embedding JSONB;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_embedding JSONB;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'waiting';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS route_after TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS routed_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE;

-- Enable full-text search on questions and route durable unanswered-question work.
CREATE INDEX IF NOT EXISTS questions_fts ON questions USING gin(to_tsvector('english', question_text));
CREATE INDEX IF NOT EXISTS questions_answer_fts ON questions USING gin(to_tsvector('english', coalesce(answer_text, '')));
CREATE INDEX IF NOT EXISTS questions_status_route_after ON questions(status, route_after);
CREATE INDEX IF NOT EXISTS questions_asker_status ON questions(asker_id, status);
CREATE INDEX IF NOT EXISTS questions_channel_status ON questions(channel_id, status);
CREATE INDEX IF NOT EXISTS commitments_maker_completed ON commitments(maker_id, completed);
CREATE INDEX IF NOT EXISTS commitments_deadline_reminder ON commitments(completed, reminder_sent, deadline);
CREATE INDEX IF NOT EXISTS feedback_message_ts ON feedback(message_ts);
CREATE INDEX IF NOT EXISTS expert_scores_keyword_score ON expert_scores(keyword, score DESC);
CREATE INDEX IF NOT EXISTS slack_installations_enterprise_id ON slack_installations(enterprise_id);
