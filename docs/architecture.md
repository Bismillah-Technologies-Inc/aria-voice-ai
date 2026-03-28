# Aria Voice Agent — Architecture

## Call Flows

Two parallel paths handle inbound calls. The EC2 bridge is the production path today; the Telnyx AI Assistant is the migration target.

### Primary: EC2 Bridge (Telnyx → Deepgram Voice Agent)

```
Inbound Call
    │
    ▼
Telnyx Call Control webhook
    │  POST /telnyx/call-control
    ▼
EC2 bridge (ec2/server.mjs)
    │
    ├─► Answer call → open bidirectional audio stream (L16/16kHz)
    │       WS /stream ↔ Telnyx
    │
    ├─► CRM memory lookup (PostgreSQL)
    │       returns existing lead if caller has called before
    │
    ├─► Deepgram Voice Agent WebSocket
    │       wss://agent.deepgram.com/v1/agent/converse
    │       │
    │       ├─► STT: Deepgram flux-general-en
    │       ├─► LLM: Anthropic claude-sonnet-4-5 (Deepgram managed)
    │       └─► TTS: Deepgram aura-2-helena-en (or ElevenLabs eleven_turbo_v2_5)
    │
    ├─► Orchestrator (Bedrock Nova Micro) — fires every user utterance
    │       classifies phase, flags, and tool hints
    │       phase transitions applied; runtime STT/LLM/TTS swaps pending API confirmation
    │
    └─► Tool Execution (lambdas/shared/tool-actions.mjs)
            ├─► log_lead          → PostgreSQL upsert
            ├─► send_sms          → Telnyx Messages API
            ├─► get_available_slots → Google Calendar freeBusy
            ├─► book_appointment  → Google Calendar events.insert
            └─► transfer_call     → Telnyx Call Control transfer
    │
    ▼ (call ends — Telnyx stream stop event)
POST_CALL_HANDLER_URL (Lambda Function URL)
    ├─► Post-call SMS (bucketed by lead quality — 5 tiers)
    └─► Bedrock summary (Claude Sonnet 4.5 via Bedrock)
```

### Migration Path: Telnyx AI Assistant

```
Inbound Call
    │
    ▼
Telnyx AI Assistant (cloud-managed)
    │
    ├─► GET /assistant/dynamic-variables
    │       injects CRM memory into assistant context
    │
    ├─► POST /assistant/tools/{tool_name}
    │       HTTP-based tool execution (same tool-actions.mjs)
    │
    └─► POST /assistant/events
            handles call.conversation.ended
            fetches transcript from Telnyx Conversations API
            triggers post-call SMS + Bedrock summary (or uses Telnyx insights)
```

### Shared Services (both paths)

```
Inbound SMS reply
    │
    ▼
SNS → sms-reply-handler Lambda
    ├─► Name capture → DB update
    ├─► Forward to operator phone (MIRZA_PHONE)
    └─► Auto-acknowledge to caller

Dashboard
    │
    ▼
Cognito JWT → API Gateway → dashboard-api Lambda
    ├─► GET /api/stats
    ├─► GET /api/calls
    ├─► GET /api/leads
    └─► GET /api/settings
```

---

## LLM Provider Strategy

| Use case | Provider | Model |
|---|---|---|
| Conversation (real-time, EC2 path) | Deepgram managed → Anthropic | `claude-sonnet-4-5` |
| Conversation (real-time, Assistant path) | Telnyx managed | configured via `telnyx-assistant.mjs` |
| TTS (default) | Deepgram | `aura-2-helena-en` |
| TTS (premium, opt-in) | ElevenLabs | `eleven_turbo_v2_5` (fallback to Deepgram) |
| Orchestrator (per-turn classification) | Bedrock | `amazon.nova-micro-v1:0` |
| Post-call summary | Bedrock | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

---

## Layer Architecture

| Layer | Component | Technology |
|---|---|---|
| 1 | Telephony Edge | Telnyx Call Control |
| 2 | Real-Time Media Gateway | EC2 bridge (`ec2/server.mjs`) + Deepgram WebSocket |
| 3 | STT + Turn-Taking | Deepgram `flux-general-en` (endpointing configurable) |
| 4 | Conversation Orchestrator | Bedrock Nova Micro — fires every user utterance |
| 5 | LLM | Deepgram managed Anthropic `claude-sonnet-4-5` |
| 6 | Tool Layer | `lambdas/shared/tool-actions.mjs` |
| 7 | TTS | Deepgram Aura-2 / ElevenLabs (premium verticals) |

---

## Database

PostgreSQL (RDS) — two tables:

- `leads` — caller CRM record (phone, name, business, callback preference, appointment)
- `calls` — call metadata (transcript, summary, tools used, outcome, duration)

`calls.runtime_provider` distinguishes the two execution paths: `deepgram_bridge` vs. `telnyx_ai_assistant`.

---

## Key Files

| File | Purpose |
|---|---|
| `ec2/server.mjs` | EC2 bridge: Telnyx webhook handler + Deepgram WS bridge |
| `lambdas/shared/deepgram.mjs` | Aria system prompt + Deepgram Voice Agent Settings config |
| `lambdas/shared/tools.mjs` | Tool schemas sent to Deepgram |
| `lambdas/shared/tool-actions.mjs` | Tool business logic (shared by both paths) |
| `lambdas/shared/orchestrator.mjs` | Layer 4 per-turn orchestrator (Bedrock Nova Micro) |
| `lambdas/shared/bedrock.mjs` | Bedrock invoke helper |
| `lambdas/shared/telnyx-assistant.mjs` | Telnyx AI Assistant config + system prompt |
| `lambdas/assistant-webhooks/index.mjs` | Telnyx AI Assistant webhook handler |
| `lambdas/post-call-handler/index.mjs` | Post-call SMS + Bedrock summary |
| `lambdas/sms-reply-handler/index.mjs` | Inbound SMS reply handler |
| `lambdas/dashboard-api/index.mjs` | Dashboard API router (Cognito-protected) |
| `db/schema.sql` | Full DDL — run once against RDS |
| `infrastructure/template.yaml` | AWS SAM template (Lambdas, Cognito, API GW, SNS) |
