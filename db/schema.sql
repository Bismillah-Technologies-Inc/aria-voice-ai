CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Leads captured by Aria
CREATE TABLE leads (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number     TEXT NOT NULL,           -- E.164 format, e.g. +17085551234
  first_name       TEXT,
  business_name    TEXT,
  business_type    TEXT,                    -- HVAC, plumbing, salon, etc.
  callback_day     TEXT,                    -- "Monday", "Tuesday", etc.
  callback_time    TEXT,                    -- "2pm", "morning", free text
  appointment_id   TEXT,                    -- Google Calendar event ID if booked
  sms_sent         BOOLEAN DEFAULT FALSE,
  transferred      BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Full call log
CREATE TABLE calls (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id       TEXT NOT NULL,           -- Telnyx call_control_id (or legacy contact id)
  conversation_id  TEXT,                    -- Telnyx AI conversation id
  lead_id          UUID REFERENCES leads(id),
  phone_number     TEXT NOT NULL,
  runtime_provider TEXT NOT NULL DEFAULT 'deepgram_bridge',
  duration_seconds INTEGER,
  transcript       TEXT,                    -- Full conversation text
  summary          TEXT,                    -- Bedrock-generated summary
  tools_used       TEXT[],                  -- Array of tool names invoked
  outcome          TEXT,                    -- 'lead_captured', 'transferred', 'abandoned'
  post_call_sms_sent BOOLEAN DEFAULT FALSE,
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

-- Index for phone lookups (CRM memory)
CREATE INDEX idx_leads_phone ON leads(phone_number);
CREATE INDEX idx_calls_contact ON calls(contact_id);
CREATE INDEX idx_calls_conversation ON calls(conversation_id);
CREATE INDEX idx_calls_phone ON calls(phone_number);
