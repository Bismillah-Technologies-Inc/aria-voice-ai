ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS runtime_provider TEXT NOT NULL DEFAULT 'deepgram_bridge';

CREATE INDEX IF NOT EXISTS idx_calls_conversation ON calls(conversation_id);
