# Aria Voice Agent MVP — Architecture

## High-Level Flow

```
Inbound Call
    │
    ▼
Amazon Connect ──► connect-handler Lambda
    │                    │
    │                    ├─► CRM Memory Lookup (PostgreSQL)
    │                    │
    │                    ├─► Deepgram Voice Agent WebSocket
    │                    │       │
    │                    │       ├─► STT: Deepgram Nova-2
    │                    │       ├─► LLM: Claude Sonnet 4.5 (Deepgram managed)
    │                    │       └─► TTS: Deepgram Aura Asteria
    │                    │
    │                    ├─► Orchestrator (Bedrock Nova Micro)
    │                    │       └─► Fires every user utterance
    │                    │       └─► Returns: phase transitions, STT/LLM/TTS swaps
    │                    │
    │                    └─► Tool Execution
    │                            ├─► log_lead → PostgreSQL
    │                            ├─► send_sms → AWS End User Messaging (SMS V2)
    │                            ├─► get_available_slots → Google Calendar
    │                            ├─► book_appointment → Google Calendar
    │                            └─► transfer_call → Amazon Connect
    │
    ▼ (call ends)
EventBridge CTR ──► post-call-handler Lambda
    │                    ├─► Post-call SMS (immediate, bucketed by outcome)
    │                    └─► Bedrock Summary (Claude Sonnet 4.5)
    │
    ▼ (SMS reply)
End User Messaging → SNS ──► sms-reply-handler Lambda
                         ├─► Name capture → DB update
                         ├─► Forward to Mirza's phone
                         └─► Auto-acknowledge to caller
```

## LLM Provider Strategy

### Deepgram Managed (conversation — no credentials needed)
- **Default**: `anthropic` / `claude-sonnet-4-5`
- **UpdateThink swaps by phase**:
  - Greeting/Closing: `anthropic` / `claude-4-5-haiku-latest`
  - Scheduling: `anthropic` / `claude-sonnet-4-5`
  - FAQ: `open_ai` / `gpt-4o-mini`

### Direct Bedrock (Lambda code)
- **Orchestrator**: `amazon.nova-micro-v1:0` — fastest model, classification only
- **Post-call summary**: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`

## Layer Architecture

| Layer | Component | Technology |
|-------|-----------|------------|
| 1 | Telephony Edge | Amazon Connect (MVP) → Telnyx (Phase 3) |
| 2 | Real-Time Media Gateway | connect-handler Lambda + Deepgram WebSocket |
| 3 | STT + Turn-Taking | Deepgram Nova-2 + Flux (Configure mid-stream) |
| 4 | Conversation Orchestrator | Bedrock Nova Micro — fires every turn |
| 5 | LLM Router | Deepgram UpdateThink — swaps model mid-call |
| 6 | Deterministic Tool Layer | Lambda tool handlers |
| 7 | TTS | Deepgram Aura / ElevenLabs (premium verticals) |

## Database

PostgreSQL (RDS) with two tables:
- `leads` — caller information, CRM memory
- `calls` — call metadata, transcripts, summaries

## Key Files

| File | Purpose |
|------|---------|
| `lambdas/shared/deepgram.mjs` | Aria system prompt + Deepgram Settings config |
| `lambdas/shared/tools.mjs` | Tool schemas + execution logic |
| `lambdas/shared/orchestrator.mjs` | Layer 4 orchestrator (Bedrock Nova Micro) |
| `lambdas/shared/bedrock.mjs` | Shared Bedrock invoke helper |
| `lambdas/connect-handler/index.mjs` | Primary call handler |
| `lambdas/post-call-handler/index.mjs` | Post-call SMS + summary |
| `lambdas/sms-reply-handler/index.mjs` | Inbound SMS reply handler |
