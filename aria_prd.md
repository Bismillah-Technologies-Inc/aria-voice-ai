# Aria Voice Agent — MVP PRD for Claude Code

**Version:** 1.0  
**Target:** Claude Code autonomous build  
**Stack:** Node.js 20 · AWS Lambda · Amazon Connect · Deepgram Voice Agent API · AWS Bedrock (Claude 3.5 Sonnet) · PostgreSQL (RDS) · Google Calendar API · Amazon Pinpoint SMS (MVP) · Groq API (Orchestrator)  
**Goal:** A live demo phone number where Aria, an AI voice agent, answers calls, qualifies SMB leads, sends real-time SMS, books appointments on Google Calendar, and logs leads to a PostgreSQL database — all within a single call.

---

## 0. How To Read This Document

Every section that starts with `## BUILD:` is a direct build instruction. Sections starting with `## CONTEXT:` are background. Claude Code should implement everything under `## BUILD:` sections exactly as specified. Do not deviate from named file paths, function signatures, environment variable names, or database column names — downstream components depend on exact naming.

---

## CONTEXT: What We're Building

A demo phone line for a Voice-First CRM product. When a small business owner calls the number:

1. Amazon Connect receives the inbound call
2. Connect triggers a Lambda (`connect-handler`) that initiates a Deepgram Voice Agent WebSocket session
3. Deepgram streams the call audio to/from its Voice Agent API, which uses Claude 3.5 Sonnet via AWS Bedrock as the LLM
4. The LLM (Aria) converses naturally, using four function-calling tools:
   - `send_sms` — texts a booking link to the caller's number in real time
   - `log_lead` — writes the captured lead to PostgreSQL
   - `book_appointment` — queries and books a slot on Google Calendar
   - `transfer_call` — transfers the call to a human via Amazon Connect
5. After the call, a second Lambda (`post-call-handler`) fires, generates a call summary via Bedrock, and persists final call metadata

---

## BUILD: Repository Structure

Create the following directory and file tree exactly. Do not add files not listed here during initial build.

```
aria-mvp/
├── .env.example
├── .gitignore
├── README.md
├── package.json                        # root — workspaces
├── infrastructure/
│   └── template.yaml                   # AWS SAM template
├── lambdas/
│   ├── connect-handler/
│   │   ├── package.json
│   │   └── index.mjs
│   ├── post-call-handler/
│   │   ├── package.json
│   │   └── index.mjs
│   └── shared/
│       ├── db.mjs                      # pg Pool singleton
│       ├── deepgram.mjs                # Deepgram WS client
│       ├── bedrock.mjs                 # Bedrock invoke helper
│       ├── calendar.mjs                # Google Calendar helper
│       ├── sms.mjs                     # Pinpoint SMS helper (Telnyx in Phase 3)
│       ├── tools.mjs                   # Tool schemas + handlers
│       └── orchestrator.mjs            # Layer 4 orchestrator (Groq/Llama call)
├── lambdas/
│   └── sms-reply-handler/
│       ├── package.json
│       └── index.mjs                   # Pinpoint inbound reply handler
├── db/
│   └── schema.sql                      # Full DDL — run once on RDS
├── scripts/
│   ├── deploy.sh                       # SAM build + deploy
│   ├── seed-calendar.js                # Seed test availability
│   └── test-call.sh                    # Simulate Connect event locally
└── docs/
    └── architecture.md
```

---

## BUILD: Environment Variables

Create `.env.example` with every variable below. All values are placeholders — the real `.env` is never committed.

```bash
# AWS
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012

# Deepgram
DEEPGRAM_API_KEY=dg_xxxxxxxxxxxxxxxxxxxx

# Bedrock — Claude 3.5 Sonnet
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
BEDROCK_REGION=us-east-1

# Database
DB_HOST=aria-mvp.xxxx.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=aria
DB_USER=aria_user
DB_PASSWORD=changeme

# Google Calendar
GOOGLE_SERVICE_ACCOUNT_EMAIL=aria@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GOOGLE_CALENDAR_ID=primary

# Amazon Pinpoint SMS (MVP — replaced by Telnyx in Phase 3)
PINPOINT_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PINPOINT_FROM_NUMBER=+1XXXXXXXXXX

# Groq API (Layer 4 Orchestrator)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx

# Reply forwarding
MIRZA_PHONE=+1XXXXXXXXXX

# Amazon Connect
CONNECT_INSTANCE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CONNECT_CONTACT_FLOW_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # transfer flow
CONNECT_QUEUE_ARN=arn:aws:connect:us-east-1:123456789012:instance/xxx/queue/xxx

# Demo config
BOOKING_LINK=https://cal.com/aria-demo
HUMAN_TRANSFER_HOURS_START=9    # 9 AM CT
HUMAN_TRANSFER_HOURS_END=17     # 5 PM CT
HUMAN_TRANSFER_TIMEZONE=America/Chicago
DEMO_BUSINESS_NAME=Apex Home Services
DEMO_AGENT_NAME=Aria
```

---

## BUILD: Root package.json

```json
{
  "name": "aria-mvp",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "lambdas/connect-handler",
    "lambdas/post-call-handler"
  ],
  "scripts": {
    "deploy": "bash scripts/deploy.sh",
    "test:local": "bash scripts/test-call.sh"
  }
}
```

---

## BUILD: Database Schema (`db/schema.sql`)

Run this once against the RDS instance. Use exact column names — they are referenced by name in `tools.mjs`.

```sql
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
  contact_id       TEXT NOT NULL,           -- Amazon Connect ContactId
  lead_id          UUID REFERENCES leads(id),
  phone_number     TEXT NOT NULL,
  duration_seconds INTEGER,
  transcript       TEXT,                    -- Full conversation text
  summary          TEXT,                    -- Bedrock-generated summary
  tools_used       TEXT[],                  -- Array of tool names invoked
  outcome          TEXT,                    -- 'lead_captured', 'transferred', 'abandoned'
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

-- Index for phone lookups (CRM memory)
CREATE INDEX idx_leads_phone ON leads(phone_number);
CREATE INDEX idx_calls_contact ON calls(contact_id);
CREATE INDEX idx_calls_phone ON calls(phone_number);
```

---

## BUILD: Shared Module — `lambdas/shared/db.mjs`

```javascript
import pg from 'pg';
const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      { rejectUnauthorized: false },
      max:      5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}
```

---

## BUILD: Shared Module — `lambdas/shared/sms.mjs`

SMS uses Amazon Pinpoint for MVP (covered by AWS credits). The `sendSms` function signature never changes — when voice migrates to Telnyx in Phase 3, only this module's internals are replaced.

```javascript
import { PinpointClient, SendMessagesCommand } from '@aws-sdk/client-pinpoint';

const pinpoint = new PinpointClient({ region: process.env.AWS_REGION });

/**
 * Send an SMS via Amazon Pinpoint.
 * Signature is stable — internals swap to Telnyx in Phase 3 without changing callers.
 * @param {string} to - E.164 phone number
 * @param {string} text - Message body
 */
export async function sendSms(to, text) {
  const command = new SendMessagesCommand({
    ApplicationId: process.env.PINPOINT_APP_ID,
    MessageRequest: {
      Addresses: {
        [to]: { ChannelType: 'SMS' }
      },
      MessageConfiguration: {
        SMSMessage: {
          Body:               text,
          MessageType:        'TRANSACTIONAL',
          OriginationNumber:  process.env.PINPOINT_FROM_NUMBER,
        }
      }
    }
  });

  const response = await pinpoint.send(command);
  return response.MessageResponse;
}
```

**Phase 3 migration note:** Replace the Pinpoint SDK with the Telnyx SDK. The function signature `sendSms(to, text)` stays identical. See Phase 3 migration section for the full swap.

---

## BUILD: Shared Module — `lambdas/shared/calendar.mjs`

```javascript
import { google } from 'googleapis';

function getAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

/**
 * Get available 30-minute slots for the next 5 business days.
 * Returns array of { start: ISO string, end: ISO string, label: "Mon Mar 10 at 2:00 PM" }
 */
export async function getAvailableSlots() {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const fiveDaysOut = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

  const busyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: fiveDaysOut.toISOString(),
      timeZone: 'America/Chicago',
      items: [{ id: process.env.GOOGLE_CALENDAR_ID }],
    },
  });

  const busy = busyRes.data.calendars[process.env.GOOGLE_CALENDAR_ID].busy || [];

  // Generate 9am–5pm slots in 30-min increments for next 5 days
  const slots = [];
  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);
  if (cursor.getHours() >= 17) {
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(9);
  } else if (cursor.getHours() < 9) {
    cursor.setHours(9);
  }

  while (cursor < fiveDaysOut && slots.length < 6) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) { // skip weekends
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      const overlaps = busy.some(b =>
        new Date(b.start) < slotEnd && new Date(b.end) > cursor
      );
      if (!overlaps && cursor.getHours() >= 9 && cursor.getHours() < 17) {
        slots.push({
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
          label: cursor.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
          }),
        });
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 30);
    if (cursor.getHours() >= 17) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(9);
      cursor.setMinutes(0);
    }
  }

  return slots;
}

/**
 * Book a specific slot.
 * @param {string} startIso - ISO start time
 * @param {string} endIso - ISO end time
 * @param {string} attendeeName
 * @param {string} attendeePhone
 * @param {string} businessName
 * @returns {string} Google Calendar event ID
 */
export async function bookSlot(startIso, endIso, attendeeName, attendeePhone, businessName) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary:     `Follow-up: ${attendeeName} — ${businessName}`,
      description: `Lead captured via Aria demo line.\nPhone: ${attendeePhone}\nBusiness: ${businessName}`,
      start: { dateTime: startIso, timeZone: 'America/Chicago' },
      end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
    },
  });

  return event.data.id;
}
```

---

## BUILD: Shared Module — `lambdas/shared/tools.mjs`

This is the most critical shared module. It defines the four Deepgram function-calling tool schemas AND the handler for each. When Deepgram calls a function, the result of `executeTool()` is sent back as the function result.

```javascript
import { query } from './db.mjs';
import { sendSms } from './sms.mjs';
import { getAvailableSlots, bookSlot } from './calendar.mjs';
import {
  ConnectClient,
  TransferContactCommand
} from '@aws-sdk/client-connect';

const connectClient = new ConnectClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────────────────────
// TOOL SCHEMAS
// These are sent to Deepgram in the initial Voice Agent config.
// Deepgram passes them to the LLM as available functions.
// ─────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    name: 'send_sms',
    description: 'Send an SMS to the caller right now. Use this when the caller agrees to receive a booking or info link. Always confirm their number before calling this.',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Caller phone number in E.164 format, e.g. +17085551234'
        },
        message_type: {
          type: 'string',
          enum: ['booking_link', 'info_link'],
          description: 'booking_link sends the Cal.com booking URL. info_link sends a general info page.'
        }
      },
      required: ['phone_number', 'message_type']
    }
  },
  {
    name: 'log_lead',
    description: 'Save the caller\'s information to the CRM database. Call this as soon as you have collected first_name AND either business_name or phone_number. Update it again when you collect more fields.',
    parameters: {
      type: 'object',
      properties: {
        phone_number:  { type: 'string', description: 'E.164 format' },
        first_name:    { type: 'string' },
        business_name: { type: 'string' },
        business_type: { type: 'string', description: 'e.g. HVAC, plumbing, dental, salon' },
        callback_day:  { type: 'string', description: 'e.g. Monday, Tuesday' },
        callback_time: { type: 'string', description: 'e.g. 2pm, morning, anytime' }
      },
      required: ['phone_number']
    }
  },
  {
    name: 'get_available_slots',
    description: 'Get the next available calendar slots for scheduling a follow-up call. Call this when the caller is ready to book a specific time. Returns up to 6 options.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a specific calendar slot for the follow-up call. Only call this after the caller has confirmed a specific slot from get_available_slots.',
    parameters: {
      type: 'object',
      properties: {
        start_iso:     { type: 'string', description: 'ISO 8601 start time from get_available_slots' },
        end_iso:       { type: 'string', description: 'ISO 8601 end time from get_available_slots' },
        attendee_name: { type: 'string' },
        phone_number:  { type: 'string' },
        business_name: { type: 'string' }
      },
      required: ['start_iso', 'end_iso', 'attendee_name', 'phone_number']
    }
  },
  {
    name: 'transfer_call',
    description: 'Transfer this call to a human. Only offer this if the caller explicitly asks to speak to a person. Check business hours first — only transfer Mon-Fri 9am-5pm CT.',
    parameters: {
      type: 'object',
      properties: {
        contact_id: {
          type: 'string',
          description: 'The Amazon Connect ContactId for this call'
        },
        reason: {
          type: 'string',
          description: 'Why the caller wants to speak to a human, e.g. pricing, technical questions'
        }
      },
      required: ['contact_id']
    }
  }
];

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────────────────

/**
 * Execute a tool call from Deepgram.
 * @param {string} toolName
 * @param {object} args - Parsed JSON arguments from LLM
 * @returns {string} - Result string to send back to Deepgram as function result
 */
export async function executeTool(toolName, args) {
  console.log('[TOOL]', toolName, JSON.stringify(args));

  try {
    switch (toolName) {

      case 'send_sms': {
        const { phone_number, message_type } = args;
        const link = message_type === 'booking_link'
          ? process.env.BOOKING_LINK
          : process.env.BOOKING_LINK; // extend later for info_link
        const text = `Hi! Here's the booking link Aria mentioned: ${link}\n\nReply STOP to opt out.`;
        await sendSms(phone_number, text);
        await query(
          `UPDATE leads SET sms_sent = TRUE, updated_at = NOW() WHERE phone_number = $1`,
          [phone_number]
        );
        return JSON.stringify({ success: true, message: 'SMS sent successfully' });
      }

      case 'log_lead': {
        const { phone_number, first_name, business_name, business_type, callback_day, callback_time } = args;
        // Upsert — if this phone number called before, update. Otherwise insert.
        const existing = await query(
          `SELECT id FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
          [phone_number]
        );
        if (existing.rows.length > 0) {
          await query(
            `UPDATE leads SET
               first_name    = COALESCE($2, first_name),
               business_name = COALESCE($3, business_name),
               business_type = COALESCE($4, business_type),
               callback_day  = COALESCE($5, callback_day),
               callback_time = COALESCE($6, callback_time),
               updated_at    = NOW()
             WHERE id = $7`,
            [phone_number, first_name, business_name, business_type,
             callback_day, callback_time, existing.rows[0].id]
          );
          return JSON.stringify({ success: true, action: 'updated', lead_id: existing.rows[0].id });
        } else {
          const res = await query(
            `INSERT INTO leads (phone_number, first_name, business_name, business_type, callback_day, callback_time)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [phone_number, first_name, business_name, business_type, callback_day, callback_time]
          );
          return JSON.stringify({ success: true, action: 'created', lead_id: res.rows[0].id });
        }
      }

      case 'get_available_slots': {
        const slots = await getAvailableSlots();
        if (slots.length === 0) {
          return JSON.stringify({ success: true, slots: [], message: 'No availability in the next 5 days' });
        }
        return JSON.stringify({ success: true, slots });
      }

      case 'book_appointment': {
        const { start_iso, end_iso, attendee_name, phone_number, business_name } = args;
        const eventId = await bookSlot(start_iso, end_iso, attendee_name, phone_number, business_name || '');
        await query(
          `UPDATE leads SET appointment_id = $1, updated_at = NOW() WHERE phone_number = $2`,
          [eventId, phone_number]
        );
        return JSON.stringify({ success: true, event_id: eventId, message: 'Appointment booked successfully' });
      }

      case 'transfer_call': {
        const { contact_id, reason } = args;

        // Check business hours
        const now = new Date();
        const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
        const hour = ct.getHours();
        const day = ct.getDay();
        const start = parseInt(process.env.HUMAN_TRANSFER_HOURS_START || '9');
        const end   = parseInt(process.env.HUMAN_TRANSFER_HOURS_END || '17');

        if (day === 0 || day === 6 || hour < start || hour >= end) {
          return JSON.stringify({
            success: false,
            available: false,
            message: 'Outside business hours. Offer to schedule a callback instead.'
          });
        }

        const command = new TransferContactCommand({
          InstanceId:      process.env.CONNECT_INSTANCE_ID,
          ContactId:       contact_id,
          ContactFlowId:   process.env.CONNECT_CONTACT_FLOW_ID,
          QueueId:         process.env.CONNECT_QUEUE_ARN,
        });
        await connectClient.send(command);
        await query(
          `UPDATE leads SET transferred = TRUE, updated_at = NOW()
           WHERE phone_number = (SELECT phone_number FROM calls WHERE contact_id = $1 LIMIT 1)`,
          [contact_id]
        );
        return JSON.stringify({ success: true, message: 'Transferring now' });
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    console.error('[TOOL ERROR]', toolName, err);
    return JSON.stringify({ success: false, error: err.message });
  }
}
```

---

## BUILD: Shared Module — `lambdas/shared/deepgram.mjs`

This module holds the Aria system prompt and builds the Deepgram Voice Agent initial config payload.

```javascript
import { TOOL_SCHEMAS } from './tools.mjs';

/**
 * Build the Deepgram Voice Agent Settings message.
 * This is the first message sent over the WebSocket after connecting.
 * @param {string} callerPhone - E.164 caller number for CRM memory lookup
 * @param {object|null} existingLead - Prior lead record if caller has called before
 */
export function buildAgentSettings(callerPhone, existingLead = null) {

  // Dynamic context injection for CRM memory
  let memoryContext = '';
  if (existingLead) {
    memoryContext = `\n\nIMPORTANT: This caller has contacted us before. What you know about them:\n` +
      `- Name: ${existingLead.first_name || 'unknown'}\n` +
      `- Business: ${existingLead.business_name || 'unknown'}\n` +
      `- Business type: ${existingLead.business_type || 'unknown'}\n` +
      `- Last called: ${existingLead.created_at}\n\n` +
      `Greet them by name if you have it. Reference what you know naturally. ` +
      `Do not read this list aloud. Weave it into conversation.`;
  }

  const SYSTEM_PROMPT = `You are Aria, an AI voice agent built to answer a live demo line for small business owners who are curious about missed call automation. The person calling you saw an ad or post about AI voice agents and called this number to learn more.

Your entire purpose is to be the demo. Do not pitch the product. Be the product. The experience of talking to you should show them exactly what their own customers would feel calling their business. Let that realization land on its own.${memoryContext}

VOICE RULES — FOLLOW THESE WITHOUT EXCEPTION:
Never use markdown, bullet points, numbered lists, asterisks, bold text, or any special characters. You are speaking out loud, not writing on a screen. Never read symbols literally. Keep sentences short. One idea at a time. Let the conversation breathe. Never dump multiple points at once. Weave information naturally into conversation. Always sound warm, confident, and natural. Not robotic. Not over-enthusiastic.

YOUR FOUR GOALS — accomplish in whatever order the conversation allows. Do not follow a rigid script.

GOAL 1 — OPEN AND ORIENT: Within the first two sentences let them know what this is. Say something like: "Thanks for calling. You're actually speaking with an AI voice agent right now — this is the demo line, so what you're experiencing is exactly what your business could have picking up your missed calls." Then ask one easy question to get them talking, like what kind of business they run.

GOAL 2 — MAKE IT PERSONAL: Once you know their business type, connect the dots to their specific pain. If they're a plumber, talk about emergency calls missed at night. If they're a salon, talk about appointment requests going to voicemail. Make them feel like you already understand their world.

GOAL 3 — SHOW CAPABILITY NATURALLY: Weave in two or three capabilities relevant to their business. Options: answering after hours, capturing contact info, qualifying leads, booking appointments, answering common questions, routing urgent calls to a human. Never list these. Work them into conversation naturally. When relevant, demonstrate a capability live — offer to text them a booking link right now, or mention you have already logged this call.

GOAL 4 — CAPTURE THEIR INFORMATION: Tell them a real person will follow up. Then collect, one at a time: first name, business name, best phone number, best day and time for a callback. Confirm each piece naturally. Do not ask for all four at once.

TOOL USAGE RULES:
- Call log_lead as soon as you have a name OR phone number. Update it as you learn more. Do not wait until the end.
- Call send_sms only after the caller has explicitly agreed to receive a text. Confirm their number first.
- Call get_available_slots when the caller is ready to pick a specific time. Read 2-3 options aloud, not all of them.
- Call book_appointment only after the caller verbally confirms a specific slot.
- Call transfer_call only if the caller explicitly asks to speak to a person. If outside business hours, offer to book a callback instead.

HANDLING SKEPTICS: If someone pushes back, agree lightly and redirect with curiosity. "That's a completely fair reaction. Honestly, it is not for every business. What would something like this actually need to do to be useful for yours?" Turn skepticism into discovery.

CLOSING: Once you have their information, thank them warmly and confirm someone will be in touch within one business day. Close on this note: remind them that what they just experienced — a natural conversation that captured their information without them having to wait on hold or leave a voicemail — is exactly what their customers would feel calling their business. Let that land. Then say goodbye.

EDGE CASES:
- Pricing questions: "Pricing depends on the setup, and the person following up will go through everything with you."
- Technical questions: Keep it simple. The follow-up call goes deeper.
- Caller in a rush: Capture what you can quickly and let them go. A partial lead beats a lost one.
- Who built this: "This demo was built by a local developer who specializes in setting these up for small businesses. The person calling you back will introduce themselves properly."

The caller phone number for this session is: ${callerPhone}`;

  return {
    type: 'Settings',
    audio: {
      input: {
        encoding:    'mulaw',
        sample_rate: 8000,
      },
      output: {
        encoding:    'mulaw',
        sample_rate: 8000,
        container:   'none',
        buffer_size: 250,
      },
    },
    agent: {
      listen: {
        model: 'nova-2',
      },
      think: {
        provider: {
          type:  'aws_bedrock',
          model: process.env.BEDROCK_MODEL_ID,
        },
        instructions: SYSTEM_PROMPT,
        functions:    TOOL_SCHEMAS,
      },
      speak: {
        model: 'aura-asteria-en',  // Deepgram's best female voice
      },
    },
    context: {
      messages: [],
      replay:   false,
    },
  };
}
```

---

## BUILD: Lambda — `lambdas/connect-handler/index.mjs`

This is the primary Lambda. Amazon Connect calls it when an inbound call arrives. It:
1. Looks up the caller in the DB for CRM memory
2. Opens a Deepgram Voice Agent WebSocket
3. Bridges audio between Connect and Deepgram
4. Handles all Deepgram events including function calls
5. Writes the call record to the DB

**Note on Amazon Connect integration:** Connect uses the Media Streaming feature to stream call audio to Lambda via a Kinesis Video Stream. The Lambda receives a trigger event from Connect with the ContactId and stream ARN, then processes audio frames from the KVS stream. Implement this using the `amazon-kinesis-video-streams-webrtc` pattern.

```javascript
import WebSocket from 'ws';
import { KinesisVideoClient, GetDataEndpointCommand } from '@aws-sdk/client-kinesis-video';
import { KinesisVideoMediaClient, GetMediaCommand } from '@aws-sdk/client-kinesis-video-media';
import { query } from '../shared/db.mjs';
import { buildAgentSettings } from '../shared/deepgram.mjs';
import { executeTool } from '../shared/tools.mjs';

const DEEPGRAM_WS_URL = 'wss://agent.deepgram.com/agent';

export const handler = async (event) => {
  console.log('[CONNECT EVENT]', JSON.stringify(event));

  // Amazon Connect passes the event via Kinesis trigger or direct Lambda invocation
  // For Contact Flow invocation, the structure is:
  const contactId   = event?.Details?.ContactData?.ContactId
                   || event?.contactId
                   || event?.ContactId;
  const callerPhone = event?.Details?.ContactData?.CustomerEndpoint?.Address
                   || event?.callerPhone
                   || '+10000000000';

  if (!contactId) {
    console.error('[ERROR] No ContactId in event');
    return { statusCode: 400, body: 'Missing ContactId' };
  }

  // ── 1. CRM Memory Lookup ──────────────────────────────────────
  let existingLead = null;
  try {
    const res = await query(
      `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [callerPhone]
    );
    if (res.rows.length > 0) {
      existingLead = res.rows[0];
      console.log('[MEMORY] Returning caller:', existingLead.first_name);
    }
  } catch (err) {
    console.warn('[MEMORY] DB lookup failed, proceeding without context:', err.message);
  }

  // ── 2. Log call start ─────────────────────────────────────────
  let callDbId;
  try {
    const res = await query(
      `INSERT INTO calls (contact_id, phone_number, lead_id, started_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [contactId, callerPhone, existingLead?.id || null]
    );
    callDbId = res.rows[0].id;
  } catch (err) {
    console.warn('[DB] Failed to log call start:', err.message);
  }

  // ── 3. Build Deepgram settings with Aria prompt ───────────────
  const agentSettings = buildAgentSettings(callerPhone, existingLead);

  // ── 4. Open Deepgram WebSocket ────────────────────────────────
  const dgWs = new WebSocket(DEEPGRAM_WS_URL, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  // State for this call
  const state = {
    transcriptParts:  [],
    toolsUsed:        [],
    outcome:          'abandoned',
    leadId:           existingLead?.id || null,
  };

  return new Promise((resolve) => {
    const cleanup = async (reason) => {
      console.log('[CLEANUP]', reason);
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.close();
      }
      // Persist final call state
      try {
        await query(
          `UPDATE calls SET
             ended_at         = NOW(),
             duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
             transcript       = $1,
             tools_used       = $2,
             outcome          = $3,
             lead_id          = $4
           WHERE id = $5`,
          [
            state.transcriptParts.join('\n'),
            state.toolsUsed,
            state.outcome,
            state.leadId,
            callDbId,
          ]
        );
      } catch (err) {
        console.warn('[DB] Failed to persist call end:', err.message);
      }
      resolve({ statusCode: 200 });
    };

    dgWs.on('open', () => {
      console.log('[DEEPGRAM] WebSocket open');
      // Send Aria configuration as first message
      dgWs.send(JSON.stringify(agentSettings));
    });

    dgWs.on('message', async (raw) => {
      // Deepgram sends both binary (audio) and text (JSON events)
      if (raw instanceof Buffer) {
        // Audio bytes — forward to Connect's media stream
        // In the Connect KVS bridge pattern, write audio chunks to the outbound stream
        // This is handled by the Connect Contact Flow media streaming setup
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      console.log('[DG MSG]', msg.type, JSON.stringify(msg).slice(0, 200));

      switch (msg.type) {

        case 'Welcome':
          console.log('[DEEPGRAM] Session ready, session_id:', msg.session_id);
          break;

        case 'SettingsApplied':
          console.log('[DEEPGRAM] Settings applied, agent active');
          break;

        case 'UserStartedSpeaking':
          // Caller interrupted — Deepgram handles barge-in automatically
          break;

        case 'ConversationText':
          // Accumulate transcript
          if (msg.role && msg.content) {
            state.transcriptParts.push(`${msg.role.toUpperCase()}: ${msg.content}`);
          }
          break;

        case 'FunctionCallRequest':
          // LLM wants to call a tool
          const { function_name, function_call_id, input } = msg;
          state.toolsUsed.push(function_name);

          let toolArgs;
          try {
            toolArgs = typeof input === 'string' ? JSON.parse(input) : input;
          } catch {
            toolArgs = {};
          }

          // Inject contactId for transfer_call tool
          if (function_name === 'transfer_call') {
            toolArgs.contact_id = contactId;
          }

          // Execute tool
          const result = await executeTool(function_name, toolArgs);

          // Update local state if lead was created
          try {
            const parsed = JSON.parse(result);
            if (parsed.lead_id) state.leadId = parsed.lead_id;
            if (parsed.success && function_name === 'log_lead') {
              state.outcome = 'lead_captured';
            }
            if (parsed.success && function_name === 'transfer_call') {
              state.outcome = 'transferred';
            }
          } catch {}

          // Send result back to Deepgram
          dgWs.send(JSON.stringify({
            type:             'FunctionCallResponse',
            function_call_id: function_call_id,
            output:           result,
          }));
          break;

        case 'AgentAudioDone':
          // Agent finished speaking — ready for next user input
          break;

        case 'Close':
          await cleanup('Deepgram closed session');
          break;

        case 'Error':
          console.error('[DEEPGRAM ERROR]', msg);
          await cleanup('Deepgram error');
          break;
      }
    });

    dgWs.on('error', async (err) => {
      console.error('[DEEPGRAM WS ERROR]', err);
      await cleanup('WebSocket error');
    });

    dgWs.on('close', async () => {
      await cleanup('WebSocket closed');
    });

    // Timeout safety — max 10 minutes per call
    setTimeout(() => cleanup('Max call duration reached'), 10 * 60 * 1000);
  });
};
```

---

## BUILD: Lambda — `lambdas/post-call-handler/index.mjs`

Triggered by Amazon Connect's Contact Trace Record (CTR) event after a call ends. Generates a Bedrock summary and updates the call record.

```javascript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { query } from '../shared/db.mjs';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

export const handler = async (event) => {
  console.log('[POST-CALL EVENT]', JSON.stringify(event));

  // CTR event contains ContactId
  const contactId = event?.detail?.contactId || event?.ContactId;
  if (!contactId) return;

  // Fetch the call record
  const callRes = await query(
    `SELECT * FROM calls WHERE contact_id = $1 LIMIT 1`,
    [contactId]
  );
  if (callRes.rows.length === 0) return;

  const call = callRes.rows[0];
  if (!call.transcript || call.transcript.trim().length < 50) return;

  // Generate summary via Bedrock
  const prompt = `You are summarizing a sales call transcript for a CRM. Be concise.

Transcript:
${call.transcript}

Provide a JSON object with these exact keys:
{
  "summary": "2-3 sentence summary of what was discussed",
  "lead_quality": "hot|warm|cold",
  "next_action": "what the follow-up person should do",
  "business_type": "type of business if mentioned",
  "pain_points": ["array", "of", "mentioned", "pain", "points"]
}

Return ONLY the JSON object, no other text.`;

  try {
    const command = new InvokeModelCommand({
      modelId:     process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept:      'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const response = await bedrock.send(command);
    const body     = JSON.parse(new TextDecoder().decode(response.body));
    const text     = body.content[0].text;
    const parsed   = JSON.parse(text);

    await query(
      `UPDATE calls SET summary = $1 WHERE id = $2`,
      [JSON.stringify(parsed), call.id]
    );

    // Also update lead if business_type was extracted and missing
    if (parsed.business_type && call.lead_id) {
      await query(
        `UPDATE leads SET business_type = COALESCE(business_type, $1), updated_at = NOW() WHERE id = $2`,
        [parsed.business_type, call.lead_id]
      );
    }

    console.log('[POST-CALL] Summary saved for contact:', contactId);
  } catch (err) {
    console.error('[POST-CALL ERROR]', err);
  }
};
```

---

## BUILD: Lambda `package.json` files

`lambdas/connect-handler/package.json`:
```json
{
  "name": "connect-handler",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-connect": "^3.0.0",
    "@aws-sdk/client-kinesis-video": "^3.0.0",
    "@aws-sdk/client-kinesis-video-media": "^3.0.0",
    "ws": "^8.14.0",
    "pg": "^8.11.0",
    "@aws-sdk/client-pinpoint": "^3.0.0",
    "googleapis": "^137.0.0"
  }
}
```

`lambdas/post-call-handler/package.json`:
```json
{
  "name": "post-call-handler",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.0.0",
    "pg": "^8.11.0"
  }
}
```

---

## BUILD: SAM Template (`infrastructure/template.yaml`)

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Aria Voice Agent MVP

Globals:
  Function:
    Runtime: nodejs20.x
    Timeout: 900          # 15 min max — covers longest calls
    MemorySize: 512
    Environment:
      Variables:
        AWS_REGION:                    !Ref AWS::Region
        DEEPGRAM_API_KEY:              !Sub '{{resolve:ssm:/aria/DEEPGRAM_API_KEY}}'
        BEDROCK_MODEL_ID:              !Sub '{{resolve:ssm:/aria/BEDROCK_MODEL_ID}}'
        BEDROCK_REGION:                !Sub '{{resolve:ssm:/aria/BEDROCK_REGION}}'
        DB_HOST:                       !Sub '{{resolve:ssm:/aria/DB_HOST}}'
        DB_PORT:                       !Sub '{{resolve:ssm:/aria/DB_PORT}}'
        DB_NAME:                       !Sub '{{resolve:ssm:/aria/DB_NAME}}'
        DB_USER:                       !Sub '{{resolve:ssm:/aria/DB_USER}}'
        DB_PASSWORD:                   !Sub '{{resolve:ssm:/aria/DB_PASSWORD}}'
        GOOGLE_SERVICE_ACCOUNT_EMAIL:  !Sub '{{resolve:ssm:/aria/GOOGLE_SERVICE_ACCOUNT_EMAIL}}'
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: !Sub '{{resolve:ssm:/aria/GOOGLE_CALENDAR_PRIVATE_KEY}}'
        GOOGLE_CALENDAR_ID:            !Sub '{{resolve:ssm:/aria/GOOGLE_CALENDAR_ID}}'
        PINPOINT_APP_ID:               !Sub '{{resolve:ssm:/aria/PINPOINT_APP_ID}}'
        PINPOINT_FROM_NUMBER:          !Sub '{{resolve:ssm:/aria/PINPOINT_FROM_NUMBER}}'
        GROQ_API_KEY:                  !Sub '{{resolve:ssm:/aria/GROQ_API_KEY}}'
        MIRZA_PHONE:                   !Sub '{{resolve:ssm:/aria/MIRZA_PHONE}}'
        CONNECT_INSTANCE_ID:           !Sub '{{resolve:ssm:/aria/CONNECT_INSTANCE_ID}}'
        CONNECT_CONTACT_FLOW_ID:       !Sub '{{resolve:ssm:/aria/CONNECT_CONTACT_FLOW_ID}}'
        CONNECT_QUEUE_ARN:             !Sub '{{resolve:ssm:/aria/CONNECT_QUEUE_ARN}}'
        BOOKING_LINK:                  !Sub '{{resolve:ssm:/aria/BOOKING_LINK}}'
        HUMAN_TRANSFER_HOURS_START:    '9'
        HUMAN_TRANSFER_HOURS_END:      '17'
        HUMAN_TRANSFER_TIMEZONE:       'America/Chicago'
        DEMO_BUSINESS_NAME:            'Apex Home Services'
        DEMO_AGENT_NAME:               'Aria'

Resources:

  ConnectHandlerFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: aria-connect-handler
      CodeUri: ../lambdas/connect-handler/
      Handler: index.handler
      # Provisioned concurrency = zero cold start on first call
      AutoPublishAlias: live
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 2
      Policies:
        - AWSLambdaBasicExecutionRole
        - Statement:
          - Effect: Allow
            Action:
              - bedrock:InvokeModel
              - bedrock:InvokeModelWithResponseStream
            Resource: '*'
          - Effect: Allow
            Action:
              - connect:TransferContact
              - connect:GetContactAttributes
            Resource: '*'
          - Effect: Allow
            Action:
              - kinesisvideo:GetDataEndpoint
              - kinesisvideo:GetMedia
            Resource: '*'
          - Effect: Allow
            Action:
              - ssm:GetParameter
            Resource: 'arn:aws:ssm:*:*:parameter/aria/*'

  PostCallHandlerFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: aria-post-call-handler
      CodeUri: ../lambdas/post-call-handler/
      Handler: index.handler
      Policies:
        - AWSLambdaBasicExecutionRole
        - Statement:
          - Effect: Allow
            Action:
              - bedrock:InvokeModel
            Resource: '*'
          - Effect: Allow
            Action:
              - ssm:GetParameter
            Resource: 'arn:aws:ssm:*:*:parameter/aria/*'
      Events:
        ConnectCTR:
          Type: EventBridgeRule
          Properties:
            Pattern:
              source:
                - aws.connect
              detail-type:
                - Amazon Connect Contact Event
              detail:
                eventType:
                  - DISCONNECTED

Outputs:
  ConnectHandlerArn:
    Description: ARN to paste into Amazon Connect Contact Flow
    Value: !GetAtt ConnectHandlerFunction.Arn
  PostCallHandlerArn:
    Description: ARN for post-call processing
    Value: !GetAtt PostCallHandlerFunction.Arn
```

---

## BUILD: Deployment Script (`scripts/deploy.sh`)

```bash
#!/bin/bash
set -e

echo "=== Aria MVP Deploy ==="

# Verify required env
if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "ERROR: AWS_ACCOUNT_ID not set"
  exit 1
fi

STACK_NAME="aria-mvp"
S3_BUCKET="aria-deploy-${AWS_ACCOUNT_ID}"
REGION="${AWS_REGION:-us-east-1}"

# Create S3 bucket for SAM artifacts if it doesn't exist
aws s3 mb "s3://${S3_BUCKET}" --region "$REGION" 2>/dev/null || true

# Install Lambda dependencies
echo "Installing connect-handler dependencies..."
cd lambdas/connect-handler && npm install --production && cd ../..

echo "Installing post-call-handler dependencies..."
cd lambdas/post-call-handler && npm install --production && cd ../..

# SAM build + deploy
sam build --template infrastructure/template.yaml

sam deploy \
  --stack-name "$STACK_NAME" \
  --s3-bucket "$S3_BUCKET" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset

echo ""
echo "=== Deploy complete ==="
echo "Next steps:"
echo "1. Copy ConnectHandlerArn from outputs above"
echo "2. Paste it into your Amazon Connect Contact Flow as the Lambda invocation ARN"
echo "3. Run: psql \$DB_URL < db/schema.sql"
echo "4. Call your Connect phone number to test Aria"
```

---

## BUILD: Local Test Script (`scripts/test-call.sh`)

Simulates a Connect event locally without needing a real phone call. Requires `.env` to be populated.

```bash
#!/bin/bash

# Load .env
export $(cat .env | grep -v '#' | xargs)

# Mock Connect event
MOCK_EVENT='{
  "Details": {
    "ContactData": {
      "ContactId": "test-contact-'$(date +%s)'",
      "CustomerEndpoint": {
        "Address": "+17085551234",
        "Type": "TELEPHONE_NUMBER"
      },
      "Channel": "VOICE"
    }
  },
  "Name": "ContactFlowEvent"
}'

echo "Invoking connect-handler locally..."
echo "$MOCK_EVENT" | node -e "
  import('./lambdas/connect-handler/index.mjs').then(m => {
    const event = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    return m.handler(event);
  }).then(r => console.log('Result:', r)).catch(e => console.error('Error:', e));
"
```

---

## BUILD: `.gitignore`

```
node_modules/
.env
*.zip
.aws-sam/
dist/
coverage/
*.log
```

---

## BUILD: Amazon Connect Contact Flow Configuration

After deploying, configure Amazon Connect manually (no API for initial flow creation). The Contact Flow should be:

```
[Start] 
  → Set Logging Behavior: Enabled
  → Set Contact Attributes: Store CallerPhone = $.CustomerEndpoint.Address
  → Invoke AWS Lambda Function:
      ARN: <ConnectHandlerArn from SAM output>
      Timeout: 8 seconds
      Function Input Parameters:
        contactId = $.ContactId
        callerPhone = $.CustomerEndpoint.Address
  → [On Success] → Play Prompt: "Thank you for calling." → Disconnect
  → [On Failure] → Play Prompt: "We're sorry, please try again." → Disconnect
```

**Enable Media Streaming on the Connect instance:**  
Connect Console → Data Storage → Live Media Streaming → Enable  
This streams audio to Kinesis Video Streams which the Lambda reads from.

---

## BUILD: SSM Parameter Store Setup

Before deploying, store all secrets in SSM. Run these AWS CLI commands with actual values:

```bash
# Replace all <values> with real credentials
aws ssm put-parameter --name /aria/DEEPGRAM_API_KEY           --value "<key>"    --type SecureString
aws ssm put-parameter --name /aria/BEDROCK_MODEL_ID           --value "anthropic.claude-3-5-sonnet-20241022-v2:0" --type String
aws ssm put-parameter --name /aria/BEDROCK_REGION             --value "us-east-1" --type String
aws ssm put-parameter --name /aria/DB_HOST                    --value "<host>"   --type SecureString
aws ssm put-parameter --name /aria/DB_PORT                    --value "5432"     --type String
aws ssm put-parameter --name /aria/DB_NAME                    --value "aria"     --type String
aws ssm put-parameter --name /aria/DB_USER                    --value "<user>"   --type SecureString
aws ssm put-parameter --name /aria/DB_PASSWORD                --value "<pass>"   --type SecureString
aws ssm put-parameter --name /aria/GOOGLE_SERVICE_ACCOUNT_EMAIL       --value "<email>" --type String
aws ssm put-parameter --name /aria/GOOGLE_CALENDAR_PRIVATE_KEY        --value "<key>"   --type SecureString
aws ssm put-parameter --name /aria/GOOGLE_CALENDAR_ID                 --value "primary" --type String
aws ssm put-parameter --name /aria/PINPOINT_APP_ID          --value "<id>"   --type String
aws ssm put-parameter --name /aria/PINPOINT_FROM_NUMBER     --value "+1XXXXXXXXXX" --type String
aws ssm put-parameter --name /aria/GROQ_API_KEY             --value "<key>"  --type SecureString
aws ssm put-parameter --name /aria/MIRZA_PHONE              --value "+1XXXXXXXXXX" --type SecureString
aws ssm put-parameter --name /aria/CONNECT_INSTANCE_ID                --value "<id>"    --type String
aws ssm put-parameter --name /aria/CONNECT_CONTACT_FLOW_ID            --value "<id>"    --type String
aws ssm put-parameter --name /aria/CONNECT_QUEUE_ARN                  --value "<arn>"   --type String
aws ssm put-parameter --name /aria/BOOKING_LINK                       --value "https://cal.com/aria-demo" --type String
```

---

## CONTEXT: AWS Bedrock Access Prerequisites

Before Claude 3.5 Sonnet is available in Bedrock, model access must be explicitly requested:

1. AWS Console → Bedrock → Model access → Manage model access
2. Select: `Claude 3.5 Sonnet v2` under Anthropic
3. Submit request (usually approved instantly for `us-east-1`)
4. Verify in CLI: `aws bedrock list-foundation-models --region us-east-1 --query "modelSummaries[?contains(modelId,'claude-3-5')]"`

---

## CONTEXT: Google Calendar Service Account Setup

The calendar integration uses a service account (not OAuth) so it works headlessly in Lambda:

1. Google Cloud Console → IAM → Service Accounts → Create service account: `aria-calendar`
2. Create JSON key → download → extract `client_email` and `private_key`
3. Share your Google Calendar with the service account email (give it "Make changes to events" permission)
4. Set `GOOGLE_CALENDAR_ID` to `primary` or the specific calendar ID

---

## BUILD: README.md

```markdown
# Aria Voice Agent MVP

AI voice agent demo line. Answers calls via Amazon Connect, runs on Deepgram Voice Agent API 
with Claude 3.5 Sonnet via Bedrock. Captures leads, books appointments, sends SMS in real time.

## Prerequisites
- AWS account with Bedrock Claude 3.5 Sonnet access enabled
- Amazon Connect instance with a claimed phone number
- Deepgram account ($200 free credit)
- Telnyx account (SMS)
- Google Cloud service account with Calendar access
- RDS PostgreSQL instance (or local for dev)

## First-Time Setup

1. Clone repo and install root deps: `npm install`
2. Copy `.env.example` to `.env` and fill in all values
3. Store secrets in SSM: see `infrastructure/template.yaml` for parameter names, run commands in PRD
4. Create database: `psql $DB_URL < db/schema.sql`
5. Deploy: `bash scripts/deploy.sh`
6. Configure Amazon Connect Contact Flow with the Lambda ARN from SAM outputs
7. Call your Connect phone number

## Local Testing

`bash scripts/test-call.sh`

## Architecture

Inbound call → Amazon Connect → connect-handler Lambda → Deepgram Voice Agent WebSocket  
Deepgram ↔ Claude 3.5 Sonnet (AWS Bedrock) · Orchestrator ↔ Groq Llama 3 8B  
Tools: Amazon Pinpoint SMS · PostgreSQL (RDS) · Google Calendar · Amazon Connect Transfer  
Post-call: EventBridge CTR → post-call-handler Lambda → Bedrock summary + SMS versioning → DB  
Inbound SMS reply: Pinpoint → SNS → sms-reply-handler Lambda → Mirza's phone + DB update
```

---

## CONTEXT: Build Order for Claude Code

Implement in this exact sequence to avoid dependency issues:

1. `db/schema.sql` — no dependencies
2. `lambdas/shared/db.mjs` — no dependencies
3. `lambdas/shared/sms.mjs` — no dependencies (Pinpoint SDK)
4. `lambdas/shared/calendar.mjs` — no dependencies
5. `lambdas/shared/orchestrator.mjs` — no dependencies (Groq API call + prompt)
6. `lambdas/shared/tools.mjs` — depends on db, sms, calendar
7. `lambdas/shared/deepgram.mjs` — depends on tools (for TOOL_SCHEMAS)
8. `lambdas/connect-handler/index.mjs` — depends on all shared
9. `lambdas/post-call-handler/index.mjs` — depends on db, sms
10. `lambdas/sms-reply-handler/index.mjs` — depends on db, sms
11. `infrastructure/template.yaml`
12. `scripts/deploy.sh`, `scripts/test-call.sh`
13. Root `package.json`, `.env.example`, `.gitignore`, `README.md`

---

## CONTEXT: Known Constraints

**Amazon Connect + Lambda audio bridge:** The full KVS (Kinesis Video Streams) audio bridge implementation is complex. For the initial MVP test, Amazon Connect can invoke Lambda synchronously to handle contact routing and Deepgram initialization. The Deepgram Voice Agent API can also accept audio via a direct SIP/WebRTC connection — if KVS bridging proves complex, explore Deepgram's native telephony BYOC (Bring Your Own Carrier) option as an alternative that eliminates the KVS layer entirely.

**Lambda timeout:** Voice calls can last 10+ minutes. Lambda's max timeout is 15 minutes (900 seconds). The SAM template sets `Timeout: 900`. Verify the Connect contact flow does not have a shorter timeout set independently.

**WebSocket in Lambda:** Standard Lambda execution supports long-running WebSocket connections as long as the handler's Promise does not resolve. The `connect-handler` uses `new Promise` pattern to stay alive for the call duration. This is valid for Lambda but requires the function to have sufficient memory (512MB minimum) and timeout.

**RDS in VPC:** If RDS is inside a VPC (recommended for production), the Lambda must also be in the same VPC. Add VPC config to the SAM template:
```yaml
VpcConfig:
  SubnetIds: [!Ref PrivateSubnet1, !Ref PrivateSubnet2]
  SecurityGroupIds: [!Ref LambdaSecurityGroup]
```

---

## CONTEXT: Post-MVP Upgrade Path

Once demo line is live and first leads are captured:

| Upgrade | Trigger | Effort |
|---|---|---|
| Swap voice to Telnyx + SMS to Telnyx | AWS credit hits $100 OR 2nd agency sub-account | ~1 day |
| Add Deepgram Flux on-the-fly config | Multi-phase call flows needed | ~2 hours |
| Add UpdateThink multi-model routing | Orchestrator phase transitions wired | ~2 hours |
| Step Functions post-call pipeline | Post-call logic exceeds single Lambda | ~1 day |
| White-label multi-tenant DB | First agency signs | Phase 3 |
| HIPAA BAA + dental vertical | Dental lead closes | Phase 4 |

---

## BUILD: Shared Module — `lambdas/shared/orchestrator.mjs`

The Layer 4 real-time orchestrator. Fires on every user utterance inside `connect-handler`. Single Groq API call — no framework, no loop, no state. Returns a JSON command object telling the system what (if anything) needs to change before Aria responds.

```javascript
/**
 * Layer 4: Conversation Orchestrator
 * 
 * Fires on every user utterance. Returns JSON commands for STT, LLM, TTS, 
 * tool hints, and phase transitions. Most turns return all-null (no change).
 * 
 * Uses Groq/Llama 3 8B for ~80-120ms response time. 
 * Do NOT swap to Claude or GPT-4o here — latency budget is tight.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const VERTICAL_KEYTERMS = {
  hvac:    ['compressor','heat pump','furnace','Trane','Carrier','Lennox','SEER',
            'warranty','filter','refrigerant','duct','BTU','emergency','no heat','no cool'],
  dental:  ['cleaning','filling','crown','root canal','extraction','implant',
            'whitening','retainer','braces','Invisalign','insurance','copay',
            'new patient','emergency','pain','bleeding'],
  legal:   ['consultation','retainer','settlement','discovery','deposition',
            'statute of limitations','contingency','filing','hearing',
            'motion','liability','damages'],
  salon:   ['cut','color','highlights','balayage','blowout','keratin','extensions',
            'manicure','pedicure','wax','facial','stylist','walk-in',
            'deposit','cancellation'],
  general: ['appointment','schedule','pricing','quote','estimate','hours',
            'location','availability','service','callback'],
};

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the Conversation Orchestrator for an AI receptionist platform.

You are NOT a conversational agent. You do NOT speak to callers. You are a real-time call state controller. Your job is to read current call state and the most recent transcript turn, then decide if any layer needs to change.

You will be called after every utterance. You must respond in under 150ms. You must respond in valid JSON only. No prose. No explanation. No markdown.

OUTPUT SCHEMA — always return exactly this structure:
{
  "phase_transition": "scheduling | faq | closing | transfer_pending | null",
  "stt_config": {
    "update": false,
    "keyterms": [],
    "eot_threshold": null,
    "eot_timeout_ms": null
  },
  "llm_update": {
    "update": false,
    "provider": "groq | bedrock | openai | null",
    "model": null,
    "prompt_variant": "greeting | scheduling | faq | rag | closing | null"
  },
  "tts_update": {
    "update": false,
    "model": "aura-asteria-en | elevenlabs | null"
  },
  "tool_hint": "log_lead | send_sms | get_available_slots | book_appointment | transfer_call | null",
  "interrupt_action": "clear_buffer | none",
  "flag_updates": {},
  "reasoning": "one sentence for logging only"
}

PHASE TRANSITIONS:
greeting → scheduling: caller mentions day/time/appointment/booking/calendar/next week/schedule/come out
greeting → faq: caller asks product question with 3+ domain vocabulary words
any → closing: lead has name AND phone AND (callback_time OR appointment_booked)
any → transfer_pending: caller explicitly asks to speak to a person

STT ON SCHEDULING: eot_threshold 0.6, eot_timeout_ms 800, inject scheduling keyterms
STT ON FAQ: eot_threshold 0.4, eot_timeout_ms 1400, inject vertical keyterms
STT DEFAULT: eot_threshold 0.5, eot_timeout_ms 1000
If last utterance duration > 8000ms: eot_threshold 0.3

LLM ROUTING:
greeting/closing: provider groq, model llama-3.1-8b-instant
scheduling: provider bedrock, model anthropic.claude-3-5-sonnet-20241022-v2:0
faq with rag: provider bedrock, model anthropic.claude-3-5-sonnet-20241022-v2:0, variant rag
faq without rag: provider openai, model gpt-4o-mini

TTS: Use elevenlabs only for legal/dental vertical FAQ turns or when caller_skeptical=true. All other turns use aura-asteria-en.

TOOL HINTS:
log_lead: turn >= 2 AND caller name appears in utterance AND lead has no name yet
get_available_slots: first transition to scheduling phase
send_sms: caller says send/text/link/yes AND sms not yet sent AND has phone number
transfer_call: phase = transfer_pending AND transfer available now

INTERRUPTS: If last utterance interrupted=true and role=agent, set interrupt_action=clear_buffer. Do NOT change phase or LLM on an interrupt.

FLAGS:
caller_skeptical=true if utterance contains: just a bot, not real, this is stupid, waste of time, AI can't, talking to a machine
caller_in_rush=true if utterance contains: I'm busy, quick question, don't have long, in a meeting, call me back

Most turns produce no changes. emit update:false on all layers unless a rule fires. Stability is a feature.`;

/**
 * Build the orchestrator input payload from current call state.
 */
export function buildOrchestratorInput(state, utteranceMsg) {
  return {
    call_phase:    state.callPhase || 'greeting',
    turn_count:    state.transcriptParts.length,
    last_utterance: {
      role:         utteranceMsg.role,
      text:         utteranceMsg.content,
      duration_ms:  utteranceMsg.duration_ms || 0,
      interrupted:  utteranceMsg.interrupted || false,
    },
    lead_state: {
      has_name:          !!state.leadData?.first_name,
      has_phone:         !!state.callerPhone,
      has_business_type: !!state.leadData?.business_type,
      has_callback_time: !!state.leadData?.callback_time,
      sms_sent:          state.smsSent || false,
      appointment_booked: !!state.leadData?.appointment_id,
    },
    tenant_config: {
      vertical:             state.vertical || 'general',
      transfer_enabled:     true,
      transfer_available_now: isWithinBusinessHours(),
      rag_enabled:          false,  // Phase 4
    },
    flags: state.flags || {},
  };
}

/**
 * Call the Groq orchestrator and return parsed commands.
 * Returns null-safe default if call fails — never crash the main call flow.
 */
export async function runOrchestrator(input) {
  const NO_CHANGE = {
    phase_transition: null,
    stt_config:  { update: false },
    llm_update:  { update: false },
    tts_update:  { update: false },
    tool_hint:   null,
    interrupt_action: 'none',
    flag_updates: {},
    reasoning: 'Orchestrator unavailable — no change.',
  };

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        max_tokens:  400,
        temperature: 0,   // Deterministic classification — no creativity needed
        messages: [
          { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
          { role: 'user',   content: JSON.stringify(input) },
        ],
      }),
    });

    const data   = await response.json();
    const text   = data.choices[0].message.content.trim();
    const parsed = JSON.parse(text);

    console.log('[ORCHESTRATOR]', parsed.reasoning);
    return parsed;

  } catch (err) {
    console.warn('[ORCHESTRATOR] Failed, returning no-change:', err.message);
    return NO_CHANGE;
  }
}

/**
 * Apply orchestrator commands to the Deepgram WebSocket and call state.
 * Only sends Configure/UpdateThink if update=true on that layer.
 */
export async function applyOrchestratorCommands(dgWs, commands, state) {
  if (!commands) return;

  // Phase transition
  if (commands.phase_transition) {
    state.callPhase = commands.phase_transition;
    console.log('[PHASE]', state.callPhase);
  }

  // Flag updates
  if (commands.flag_updates && Object.keys(commands.flag_updates).length > 0) {
    state.flags = { ...(state.flags || {}), ...commands.flag_updates };
  }

  // Interrupt — clear audio buffer
  if (commands.interrupt_action === 'clear_buffer') {
    dgWs.send(JSON.stringify({ type: 'Clear' }));
    return; // Don't apply other updates on an interrupt
  }

  // STT reconfiguration via Deepgram Configure
  if (commands.stt_config?.update) {
    const configure = { type: 'Configure', listen: {} };
    if (commands.stt_config.keyterms?.length)   configure.listen.keyterms = commands.stt_config.keyterms;
    if (commands.stt_config.eot_threshold)       configure.listen.endpointing = commands.stt_config.eot_threshold;
    if (commands.stt_config.eot_timeout_ms)      configure.listen.utterance_end_ms = commands.stt_config.eot_timeout_ms;
    dgWs.send(JSON.stringify(configure));
    console.log('[STT] Reconfigured:', JSON.stringify(configure.listen));
  }

  // LLM swap via Deepgram UpdateThink
  if (commands.llm_update?.update) {
    const updateThink = {
      type:  'UpdateThink',
      think: {
        provider: {
          type:  commands.llm_update.provider === 'bedrock' ? 'aws_bedrock' : commands.llm_update.provider,
          model: commands.llm_update.model,
        },
      },
    };
    if (commands.llm_update.prompt_variant) {
      updateThink.think.instructions = getPromptVariant(commands.llm_update.prompt_variant, state);
    }
    dgWs.send(JSON.stringify(updateThink));
    console.log('[LLM] Swapped to:', commands.llm_update.model);
  }

  // TTS swap
  if (commands.tts_update?.update) {
    dgWs.send(JSON.stringify({
      type:  'UpdateSpeak',
      speak: { model: commands.tts_update.model },
    }));
    console.log('[TTS] Swapped to:', commands.tts_update.model);
  }

  // Store tool hint in state for the next FunctionCallRequest handler
  if (commands.tool_hint) {
    state.pendingToolHint = commands.tool_hint;
  }
}

function isWithinBusinessHours() {
  const now = new Date();
  const ct  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const h   = ct.getHours();
  const d   = ct.getDay();
  return d >= 1 && d <= 5 && h >= 9 && h < 17;
}

function getPromptVariant(variant, state) {
  const variants = {
    scheduling: `You are Aria handling the scheduling phase. Your only goal is to get a confirmed appointment booked.
- Offer exactly 2 slots per turn, not 3.
- If a slot is rejected, extract the constraint and use it to filter your next proposal. Never re-offer a rejected slot.
- If 4+ slots have been rejected, offer to text the full calendar link instead.
- Confirm with exact day, date, and time before booking: "So that's Tuesday March 11th at 2pm Central — does that work?"
- Do not book until they say yes.`,

    closing: `You are Aria closing this call. The lead has been captured. Thank them warmly, confirm someone will be in touch within one business day. Close with: remind them that what they just experienced — a natural conversation that captured their information without hold or voicemail — is exactly what their customers would feel. Let that land. Then say goodbye.`,

    faq: `You are Aria answering questions about the caller's specific business. Keep answers short and conversational. One idea at a time. After answering, gently steer back toward scheduling.`,
  };
  return variants[variant] || null;
}
```

---

## BUILD: Lambda — `lambdas/post-call-handler/index.mjs` (Updated)

Updated to include post-call SMS versioning. SMS fires first (within ~2 seconds of hangup), then the Bedrock summary runs asynchronously.

```javascript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { query } from '../shared/db.mjs';
import { sendSms } from '../shared/sms.mjs';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

export const handler = async (event) => {
  console.log('[POST-CALL EVENT]', JSON.stringify(event));

  const contactId = event?.detail?.contactId || event?.ContactId;
  if (!contactId) return;

  const callRes = await query(
    `SELECT * FROM calls WHERE contact_id = $1 LIMIT 1`,
    [contactId]
  );
  if (!callRes.rows.length) return;

  const call = callRes.rows[0];

  // Fetch lead record
  let lead = null;
  if (call.lead_id) {
    const leadRes = await query(`SELECT * FROM leads WHERE id = $1`, [call.lead_id]);
    if (leadRes.rows.length) lead = leadRes.rows[0];
  }
  if (!lead && call.phone_number) {
    const leadRes = await query(
      `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [call.phone_number]
    );
    if (leadRes.rows.length) lead = leadRes.rows[0];
  }

  // ── 1. POST-CALL SMS (fires immediately) ──────────────────────
  await sendPostCallSms(call, lead);

  // ── 2. BEDROCK SUMMARY (runs after SMS) ───────────────────────
  if (!call.transcript || call.transcript.trim().length < 50) return;

  const prompt = `You are summarizing a sales call transcript for a CRM. Be concise.

Transcript:
${call.transcript}

Return ONLY a JSON object with these exact keys:
{
  "summary": "2-3 sentence summary",
  "lead_quality": "hot|warm|cold",
  "next_action": "what the follow-up person should do",
  "business_type": "type of business if mentioned",
  "pain_points": ["array", "of", "pain", "points"]
}`;

  try {
    const command = new InvokeModelCommand({
      modelId:     process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept:      'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const response = await bedrock.send(command);
    const body     = JSON.parse(new TextDecoder().decode(response.body));
    const parsed   = JSON.parse(body.content[0].text);

    await query(`UPDATE calls SET summary = $1 WHERE id = $2`, [JSON.stringify(parsed), call.id]);

    if (parsed.business_type && call.lead_id) {
      await query(
        `UPDATE leads SET business_type = COALESCE(business_type, $1), updated_at = NOW() WHERE id = $2`,
        [parsed.business_type, call.lead_id]
      );
    }
  } catch (err) {
    console.error('[POST-CALL SUMMARY ERROR]', err);
  }
};

// ── SMS VERSIONING ────────────────────────────────────────────────────────────

async function sendPostCallSms(call, lead) {
  if (!call.phone_number) return;

  const bucket = classifyCallBucket(call, lead);
  if (bucket === 0) return;

  const message = buildSmsVariant(bucket, lead, call);
  if (!message) return;

  try {
    await sendSms(call.phone_number, message);
    console.log(`[POST-CALL SMS] Bucket ${bucket} → ${call.phone_number}`);
  } catch (err) {
    console.error('[POST-CALL SMS ERROR]', err.message);
  }
}

function classifyCallBucket(call, lead) {
  if (call.duration_seconds < 20) return 0;
  if (call.outcome === 'transferred') return 5;

  const hasName         = !!lead?.first_name;
  const hasBusinessType = !!lead?.business_type;
  const hasCallbackTime = !!lead?.callback_time;
  const hasAppointment  = !!lead?.appointment_id;

  if (hasName && hasBusinessType && (hasCallbackTime || hasAppointment)) return 4;
  if (hasName && hasBusinessType) return 3;
  if (hasName || hasBusinessType) return 2;
  return 1;
}

function buildSmsVariant(bucket, lead, call) {
  const name    = lead?.first_name || null;
  const bizType = lead?.business_type || 'your business';
  const apptTime = lead?.appointment_label || null;
  const bookLink = process.env.BOOKING_LINK;

  const variants = {
    1: `Hey — you just called the AI demo line. That was Aria. If the timing was bad or you got cut off, just call back whenever. Or reply here and I'll answer any questions personally. — Mirza`,

    2: name
      ? `Hey ${name}! You just called the AI demo line — hope Aria made a decent first impression 😄 I'm Mirza. If you want to see what this would look like set up for your business, just reply and we'll find a time. No pressure.`
      : `Hey! You were just talking to Aria about ${bizType} — I'm Mirza, I build these. Just reply with your name and I'll personally walk you through what this would look like for your operation. 🤙`,

    3: `Hey ${name} — Aria grabbed your info but we didn't get a time on the calendar. I'd love to show you what this looks like set up for ${bizType}. Just reply with a day and time that works. — Mirza`,

    4: apptTime
      ? `Hey ${name} — you're all set! Your call with Mirza is confirmed for ${apptTime}. Reply here if anything comes up. See you then. — Aria`
      : `Hey ${name} — great talking through this. Someone will reach out within one business day to walk you through exactly what this would look like for ${bizType}. — Aria`,

    5: `Hey ${name || 'there'} — looks like we got cut off during the transfer. Mirza here — just reply and I'll call you right back, or grab a time here: ${bookLink}`,
  };

  return variants[bucket] || null;
}
```

---

## BUILD: Lambda — `lambdas/sms-reply-handler/index.mjs`

Triggered by Pinpoint → SNS when a lead replies to a post-call SMS. Auto-handles name captures, forwards everything else to Mirza's personal number in real time.

```javascript
import { query } from '../shared/db.mjs';
import { sendSms } from '../shared/sms.mjs';

export const handler = async (event) => {
  const snsMessage  = JSON.parse(event.Records[0].Sns.Message);
  const fromNumber  = snsMessage.originationNumber;
  const replyText   = snsMessage.messageBody?.trim() || '';

  console.log(`[SMS REPLY] From: ${fromNumber}, Body: "${replyText}"`);

  // Look up lead by phone number
  const leadRes = await query(
    `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
    [fromNumber]
  );

  if (!leadRes.rows.length) {
    // Unknown number — open a new conversation
    await sendSms(fromNumber,
      `Hey! Mirza here. I don't have your info on file yet — ` +
      `what's your name and what kind of business do you run? I'll reach out personally.`
    );
    return;
  }

  const lead = leadRes.rows[0];

  // Detect if reply looks like a name (short, no URL, under 40 chars)
  const looksLikeName = replyText.split(' ').length <= 3 &&
                        !replyText.includes('http') &&
                        replyText.length < 40 &&
                        replyText.length > 1;

  if (looksLikeName && !lead.first_name) {
    // Capture the name they just texted, send booking link
    await query(
      `UPDATE leads SET first_name = $1, updated_at = NOW() WHERE id = $2`,
      [replyText, lead.id]
    );
    await sendSms(fromNumber,
      `Got it, ${replyText}! I'll reach out within one business day. ` +
      `Or if you want to grab a time now: ${process.env.BOOKING_LINK}`
    );
    console.log(`[SMS REPLY] Name captured: ${replyText} for lead ${lead.id}`);
    return;
  }

  // Everything else — forward to Mirza immediately + send acknowledgement
  await Promise.all([
    sendSms(process.env.MIRZA_PHONE,
      `[ARIA LEAD REPLY]\n` +
      `From: ${fromNumber}\n` +
      `Lead: ${lead.first_name || 'unknown'} — ${lead.business_type || 'unknown biz'}\n` +
      `Message: "${replyText}"`
    ),
    sendSms(fromNumber,
      `Got it — Mirza will follow up with you shortly. 👍`
    ),
  ]);

  console.log(`[SMS REPLY] Forwarded to Mirza from ${fromNumber}`);
};
```

`lambdas/sms-reply-handler/package.json`:
```json
{
  "name": "sms-reply-handler",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-pinpoint": "^3.0.0",
    "pg": "^8.11.0"
  }
}
```

Add to `infrastructure/template.yaml` Resources:

```yaml
  SmsReplyHandlerFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: aria-sms-reply-handler
      CodeUri: ../lambdas/sms-reply-handler/
      Handler: index.handler
      Timeout: 30
      Policies:
        - AWSLambdaBasicExecutionRole
        - Statement:
          - Effect: Allow
            Action:
              - mobiletargeting:SendMessages
            Resource: '*'
          - Effect: Allow
            Action:
              - ssm:GetParameter
            Resource: 'arn:aws:ssm:*:*:parameter/aria/*'
      Events:
        PinpointSnsReply:
          Type: SNS
          Properties:
            Topic: !Ref SmsReplyTopic

  SmsReplyTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: aria-sms-replies
```

**Pinpoint two-way SMS setup (manual, one-time):**
1. AWS Console → Pinpoint → SMS and voice → Phone numbers → Request number
2. Enable two-way SMS on the number
3. Set SNS topic to `aria-sms-replies` (created by SAM above)
4. Pinpoint will publish inbound messages to that topic, triggering the Lambda

---

## CONTEXT: Phase 3 SMS Migration (Pinpoint → Telnyx)

When voice migrates to Telnyx, SMS migrates at the same time. Two changes only:

**1. Replace `lambdas/shared/sms.mjs` internals:**
```javascript
// Replace Pinpoint SDK with Telnyx SDK
import Telnyx from 'telnyx';
const telnyx = Telnyx(process.env.TELNYX_API_KEY);

export async function sendSms(to, text) {
  const response = await telnyx.messages.create({
    from:                 process.env.TELNYX_FROM_NUMBER,
    to,
    text,
    messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID,
  });
  return response.data;
}
// Function signature unchanged — all callers work without modification
```

**2. Replace inbound webhook:**
- Remove: Pinpoint two-way SMS → SNS topic trigger
- Add: Telnyx inbound webhook URL pointing to `sms-reply-handler` Lambda function URL
- Remove SNS trigger from SAM template, add `FunctionUrl` resource instead
- Simpler — cuts out the SNS middleman entirely

**SSM parameter swap:**
```bash
# Remove
aws ssm delete-parameter --name /aria/PINPOINT_APP_ID
aws ssm delete-parameter --name /aria/PINPOINT_FROM_NUMBER

# Add
aws ssm put-parameter --name /aria/TELNYX_API_KEY                  --value "<key>" --type SecureString
aws ssm put-parameter --name /aria/TELNYX_MESSAGING_PROFILE_ID     --value "<id>"  --type String
aws ssm put-parameter --name /aria/TELNYX_FROM_NUMBER              --value "+1XXXXXXXXXX" --type String
```

Telnyx SMS pricing: ~$0.004/message vs Pinpoint $0.00645 — approximately 40% savings. At scale this compounds significantly.
