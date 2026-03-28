# Aria Compatibility Analysis
**voice_crm_report.md × aria_prd.md × Current Codebase**

*Generated: 2026-03-28*

---

## 1. Executive Summary

The codebase has **substantially diverged** from `aria_prd.md` but is **largely aligned** with the strategic vision in `voice_crm_report.md`. The PRD was written for an Amazon Connect + Lambda architecture that was never built. Instead the project pivoted to a Telnyx + EC2 bridge architecture — the exact telephony stack the CRM report recommends. The core CRM data model, tool schemas, and Google Calendar integration remain consistent across all three documents.

**Compatibility scores:**

| Dimension | PRD vs. Code | CRM Report vs. Code |
|---|---|---|
| Telephony stack | ❌ Amazon Connect → ✅ Telnyx | ✅ Aligned |
| Audio codec/format | ❌ mulaw/8kHz → ✅ linear16/16kHz | N/A |
| SMS provider | ❌ Pinpoint → ✅ Telnyx SMS | ✅ Aligned (Phase 3 note) |
| LLM provider | ❌ AWS Bedrock → ✅ Anthropic direct | Partial |
| STT model | ❌ nova-2 → ✅ flux-general-en | Partial |
| Tool schemas | ✅ Match | ✅ Aligned |
| DB schema | ✅ Core matches + extended | ✅ Aligned |
| Calendar booking | ✅ Implemented | ✅ Aligned |
| CRM memory | ✅ Implemented | ✅ Aligned |
| QuickBooks integration | ❌ Not implemented | ❌ Not implemented |
| Enterprise CRM overlay | ❌ Not implemented | ❌ Not implemented |
| RAG | ❌ Not implemented | ❌ Not implemented |

---

## 2. Architecture Divergence: PRD vs. Actual

### 2.1 Telephony Layer — Full Pivot from Amazon Connect to Telnyx

**PRD specifies:**
- Amazon Connect receives inbound calls
- `lambdas/connect-handler/index.mjs` bridges Connect → Deepgram via Kinesis Video Streams
- `connect.TransferContactCommand` for human transfer

**What exists:**
- `ec2/server.mjs` — HTTP server handling Telnyx Call Control webhooks + WebSocket bridge to Deepgram
- `lambdas/assistant-webhooks/index.mjs` — A second integration path supporting Telnyx AI Assistant mode
- `lambdas/shared/telnyx-assistant.mjs` — Telnyx AI Assistant dynamic variables
- Human transfer via Telnyx Call Control API (`/v2/calls/{id}/actions/transfer`)
- **No `connect-handler` Lambda exists.** Amazon Connect is completely absent.

**Impact:** The PRD's primary Lambda (`connect-handler`) was never built. The entire telephony + audio bridge layer was redesigned. This is a good-faith pivot — Telnyx is the provider the CRM report recommends (Section 2.1.1).

### 2.2 Audio Codec

**PRD:** `mulaw` / `8000 Hz` (Amazon Connect's native format)
**Actual (`deepgram.mjs`):** `linear16` / `16000 Hz` (Telnyx bidirectional stream codec)

The Telnyx answer action in `ec2/server.mjs` requests:
```
stream_bidirectional_codec: 'L16'
stream_bidirectional_sampling_rate: 16000
```
This matches the Deepgram settings. Consistent internally.

### 2.3 LLM Provider

**PRD (deepgram.mjs spec):**
```javascript
think: { provider: { type: 'aws_bedrock', model: process.env.BEDROCK_MODEL_ID } }
```

**Actual (`lambdas/shared/deepgram.mjs`):**
```javascript
think: { provider: { type: 'anthropic', model: 'claude-sonnet-4-5' } }
```

**Impact:** The codebase uses Deepgram's managed Anthropic integration rather than routing through AWS Bedrock. This is simpler and eliminates AWS IAM credential management for the real-time call path. Bedrock is still used for the post-call summary (`post-call.mjs`) and the orchestrator (`bedrock.mjs`).

### 2.4 FunctionCallRequest Protocol Format

**PRD connect-handler (expected Deepgram format):**
```javascript
const { function_name, function_call_id, input } = msg;
```

**Actual `ec2/server.mjs` (new Deepgram format):**
```javascript
const functions = dgMsg.functions || [];
for (const fn of functions) {
  const { id: fnCallId, name: fnName, arguments: fnArgs } = fn;
}
```

The codebase correctly uses the **current** Deepgram Voice Agent API format where `FunctionCallRequest` carries a `functions` array. The PRD's expected format is the older single-function format. This is a positive divergence — the code is on the current protocol.

### 2.5 transfer_call Tool Parameter

**PRD tools.mjs spec:**
```javascript
{ required: ['contact_id'] }  // Amazon Connect ContactId
// Uses: new TransferContactCommand({ ContactId: contact_id })
```

**Actual tools.mjs:**
```javascript
{ required: ['call_control_id'] }  // Telnyx call_control_id
// Uses: fetch('https://api.telnyx.com/v2/calls/{id}/actions/transfer')
```

Consistent with the telephony pivot. The `call_control_id` is correctly injected in `ec2/server.mjs:342`:
```javascript
if (fnName === 'transfer_call') {
  toolArgs.call_control_id = state.callControlId;
}
```

### 2.6 SMS Provider

**PRD:** Amazon Pinpoint (`@aws-sdk/client-pinpoint`)
**Actual (`lambdas/shared/sms.mjs`):** Telnyx Messages API (`fetch` to `api.telnyx.com/v2/messages`)

PRD's own Phase 3 migration note anticipated this exact swap: *"Replace the Pinpoint SDK with the Telnyx SDK. The function signature `sendSms(to, text)` stays identical."* That migration has been completed.

### 2.7 TTS Voice

**PRD:** `aura-asteria-en`
**Actual:** `aura-2-helena-en` (default), with optional ElevenLabs via `TTS_PROVIDER` env var + fallback chain

The actual implementation is more capable than specified — it supports:
- Deepgram Aura-2 (upgraded model generation)
- ElevenLabs `eleven_turbo_v2_5` via WebSocket
- Automatic fallback to Deepgram if ElevenLabs credentials absent

This directly implements the CRM report's TTS white-label recommendation (Section 2.1.4).

### 2.8 Deepgram Config Schema

**PRD spec:**
```javascript
{ agent: { listen: { model: 'nova-2' }, think: { instructions: ..., context: { messages: [] } } } }
```

**Actual:**
```javascript
{ agent: { language: 'en', listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en' } }, think: { provider: {...}, prompt: ..., functions: [...] } } }
```

Key differences:
- `model: 'nova-2'` → `provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en' }` (current API)
- `instructions:` key → `prompt:` key (current API)
- `context.messages` removed (not needed with Deepgram managing session state)
- Top-level `language: 'en'` added

These reflect Deepgram API evolution. The actual code uses the current spec.

### 2.9 System Prompt Philosophy

**PRD system prompt:** Sales-funnel oriented — 4 explicit goals, scripted opening line, "HANDLING SKEPTICS" section with a canned redirect phrase.

**Actual system prompt:** Explicitly rejects scripts, varied greetings (randomized array of 4), rules against reusing stock phrases, explicitly says "Do not sound polished, salesy, over-rehearsed." The skeptic handling is more authentic: acknowledge plainly without defensiveness rather than redirecting to a pitch.

The actual prompt is a meaningful improvement for a demo product where inauthenticity would undermine the value proposition.

---

## 3. DB Schema: PRD vs. Actual

**PRD schema (`db/schema.sql` spec):**
```sql
CREATE TABLE calls (
  contact_id TEXT,  -- Amazon Connect ContactId
  ...
);
```

**Actual schema (`db/schema.sql`):**
```sql
CREATE TABLE calls (
  contact_id       TEXT,              -- Telnyx call_control_id (or legacy)
  conversation_id  TEXT,             -- NEW: Telnyx AI conversation id
  runtime_provider TEXT DEFAULT 'deepgram_bridge', -- NEW: tracks which path
  post_call_sms_sent BOOLEAN DEFAULT FALSE,         -- NEW: post-call SMS flag
  ...
);
```

Additional indexes:
```sql
CREATE INDEX idx_calls_conversation ON calls(conversation_id);  -- NEW
```

The schema is a strict superset of the PRD. All PRD columns exist; additional columns support the Telnyx AI Assistant mode and post-call SMS system.

---

## 4. What's Been Added Beyond Both Documents

### 4.1 Layer 4 Conversation Orchestrator (`lambdas/shared/orchestrator.mjs`)
Not mentioned in either document. Fires on every user utterance using Amazon Nova Micro on Bedrock to classify:
- Phase transitions (greeting → scheduling → faq → closing → transfer_pending)
- STT configuration updates (endpointing thresholds, domain keyterms)
- LLM provider/model routing (fast path vs. reasoning path)
- TTS model swaps (ElevenLabs for high-touch verticals)
- Tool hints

**Current state:** Phase transitions and flag updates are applied. All runtime STT/LLM/TTS mutations are currently **disabled with compatibility warnings** — the orchestrator computes them but does not send protocol messages. This is intentional for stability.

### 4.2 Telnyx AI Assistant Mode (`lambdas/assistant-webhooks/index.mjs`)
A complete second integration path supporting Telnyx's native AI Assistant product (vs. the Deepgram Voice Agent bridge). Supports:
- `/assistant/dynamic-variables` — injects CRM memory into Telnyx AI Assistant prompts
- `/assistant/tools/{tool_name}` — HTTP-based tool execution (vs. WebSocket)
- `/assistant/events` — handles Telnyx conversation lifecycle events, fetches transcripts via Telnyx API, triggers post-call SMS
- Webhook secret validation via SSM

### 4.3 Post-Call SMS Bucketing (`lambdas/shared/post-call.mjs`)
5-tier SMS system based on lead quality captured during call:
- Bucket 0: Call < 20s — no SMS
- Bucket 1: No lead data — abandoned call follow-up
- Bucket 2: Partial info — gentle re-engagement
- Bucket 3: Name + business type, no time — scheduling nudge
- Bucket 4: Full capture or appointment — confirmation/follow-up
- Bucket 5: Transfer outcome — re-connect message

### 4.4 Dashboard API + UI (`lambdas/dashboard-api/`, `dashboard/`)
Not in PRD scope. Adds a web dashboard with Cognito authentication (configured in `infrastructure/template.yaml`).

---

## 5. What's NOT Implemented (from Both Documents)

### From voice_crm_report.md (strategic roadmap items):

| Feature | Section | Status |
|---|---|---|
| QuickBooks Online API integration | 3.1 | Not started |
| QBO Webhooks for real-time sync | 3.2 | Not started |
| Enterprise CRM overlay (Salesforce/HubSpot) | 4.1 | Not started |
| Conflict resolution / source-of-truth logic | 4.2 | Not started |
| RAG-powered product inquiry (Pinecone) | 5.2 | `rag_enabled: false` placeholder only |
| Text-to-Pay / Stripe SMS handoff | 5.3 | Not started |
| Groq fast-path LLM routing | 2.1.3 | Orchestrator designed for it, runtime switching disabled |

### From aria_prd.md:
| Item | Status |
|---|---|
| `connect-handler` Lambda | Not built (telephony pivoted) |
| Amazon Connect ContactFlow integration | Not built |
| Amazon Pinpoint SMS | Replaced by Telnyx |
| `scripts/deploy.sh`, `scripts/test-call.sh` | Not reviewed / uncertain state |

---

## 6. Test Call Log Analysis

The `logs/` directory contains three files:
- `logs/combined.log` — Contains only `@cyanheads/git-mcp-server` initialization logs (not a voice call)
- `logs/interactions.log` — Empty
- `logs/error.log` — Empty

**No voice call logs are present in the filesystem.** The EC2 bridge server (`ec2/server.mjs`) logs to stdout/stderr via `console.log` and does not write to files. To capture a test call log, the server must be run with output redirection (e.g., `node server.mjs >> logs/combined.log 2>&1`).

The `.loki/events.jsonl` shows 3 automated build iterations (2026-03-07), all failed with `exitCode: 1`. These represent Loki autonomous build attempts. The failures likely occurred because the build system attempted to follow the PRD's Amazon Connect architecture, which requires AWS service provisioning that isn't available in the local environment.

---

## 7. Critical Compatibility Issues to Resolve

### 7.1 PRD is Structurally Outdated
The PRD's `connect-handler` Lambda specification describes architecture that was replaced. If the PRD is used as the canonical reference going forward, it will cause confusion. **Recommendation:** Treat the PRD as historical context; the CRM report's strategic vision is the active north star.

### 7.2 Orchestrator Runtime Mutations are Disabled
The orchestrator correctly classifies call phases and recommends STT/LLM/TTS changes, but all of those mutations are skipped with log messages like:
```
[ORCHESTRATOR] LLM update requested but skipped for compatibility
[ORCHESTRATOR] STT update requested but skipped for compatibility
```
This means the LLM fast-path/reasoning-path routing from the CRM report (Section 2.1.3) is designed but not active. The Deepgram Voice Agent API's confirmed surface for `UpdateSettings`-style messages needs to be validated before enabling.

### 7.3 Dual Integration Paths Need Clarity
Two separate call flows exist simultaneously:
1. EC2 bridge (`ec2/server.mjs`) — Deepgram Voice Agent via WebSocket
2. Lambda webhooks (`lambdas/assistant-webhooks/`) — Telnyx AI Assistant via HTTP

Both write to the same database. The `runtime_provider` column (`deepgram_bridge` vs. `telnyx_ai_assistant`) distinguishes them. It's unclear from the current codebase which path is active in production. **Recommendation:** Document which flow is primary and under what conditions each is used.

### 7.4 Post-Call Lambda Trigger Logic
`ec2/server.mjs` triggers the post-call Lambda by `POST`ing to `process.env.POST_CALL_HANDLER_URL`. However `post-call-handler/index.mjs` line 13 has:
```javascript
if (!event.requestContext?.http) return;
```
This guard expects an HTTP Function URL invocation. The call from EC2 bridge uses `fetch()` directly, which produces the correct HTTP context. However if the Lambda is invoked directly (e.g., by SAM CLI or test harness), this guard will silently abort. The `contactId` query in the handler uses `contact_id` as a lookup key, but the EC2 bridge passes `callDbId` (the UUID primary key from `calls.id`) as `contactId` in the POST body — this will fail to match since the DB query is `WHERE contact_id = $1`, not `WHERE id = $1`.

**This is a bug:** `ec2/server.mjs:201-209` posts `{ contactId: state.callDbId }` but `post-call-handler/index.mjs:21-24` queries `WHERE contact_id = $1` using that value. `state.callDbId` is the UUID `id` of the calls row, while `contact_id` is the Telnyx `call_control_id`. These are different values.

### 7.5 STT Model: nova-2 vs. flux-general-en
The CRM report specifies Deepgram `nova-2` (Section 2.1.2). The actual code uses `flux-general-en`. These are different Deepgram models — `flux-general-en` is a newer, lower-latency model in Deepgram's Voice Agent API. This is likely an intentional upgrade but should be documented.

---

## 8. Summary of What's Working vs. What Needs Attention

### Working and Aligned
- Telnyx telephony with Call Control webhook handling
- Deepgram Voice Agent WebSocket bridge (linear16/16kHz)
- Anthropic Claude via Deepgram managed provider
- All 5 tool schemas (send_sms, log_lead, get_available_slots, book_appointment, transfer_call)
- Tool execution split into `tools.mjs` (schemas) + `tool-actions.mjs` (logic)
- Google Calendar slot availability + booking
- Telnyx SMS delivery
- CRM memory (returning caller lookup in DB)
- Lead upsert (COALESCE pattern)
- Barge-in handling (clear event on `UserStartedSpeaking`)
- Post-call Bedrock summary generation
- Post-call SMS bucketing (5-tier)
- Telnyx AI Assistant webhook integration
- Cognito-protected dashboard
- ElevenLabs TTS option with Deepgram fallback

### Needs Attention
1. **Bug:** Post-call Lambda `contactId` lookup uses wrong column (`contact_id` vs. `id`)
2. **Gap:** No actual call logs exist — logging infrastructure needs to write to files for observability
3. **Gap:** Orchestrator runtime mutations (STT/LLM/TTS) disabled — needs Deepgram API confirmation
4. **Gap:** PRD is misleading as a reference — should be updated or archived
5. **Unstarted:** QuickBooks, Enterprise CRM overlay, RAG, Text-to-Pay (Phase 3+ scope)
6. **Clarification needed:** Which integration path (EC2 bridge vs. Telnyx AI Assistant) is primary
