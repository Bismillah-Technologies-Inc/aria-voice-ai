-- Migration 001: Add settings table for runtime agent configuration
-- Run: psql $DB_URL < db/migrations/001_add_settings.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS settings (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name        TEXT NOT NULL DEFAULT 'Apex Home Services',
  agent_name           TEXT NOT NULL DEFAULT 'Aria',
  greeting_style       TEXT NOT NULL DEFAULT 'professional',
  transfer_hours_start INTEGER NOT NULL DEFAULT 9,
  transfer_hours_end   INTEGER NOT NULL DEFAULT 17,
  transfer_timezone    TEXT NOT NULL DEFAULT 'America/Chicago',
  booking_link         TEXT DEFAULT 'https://cal.com/aria-demo',
  sms_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  auto_summary         BOOLEAN NOT NULL DEFAULT TRUE,
  custom_prompt        TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default row for MVP (single-tenant)
INSERT INTO settings (business_name, agent_name)
VALUES ('Apex Home Services', 'Aria')
ON CONFLICT DO NOTHING;
