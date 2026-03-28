# Aria Voice Agent MVP

AI voice agent demo line. The current production path still supports the legacy
`Telnyx -> EC2 bridge -> Deepgram Voice Agent` flow, but this repo now also
includes a phase-one migration path to a native Telnyx AI Assistant that keeps
the existing CRM, calendar, dashboard, and SMS workflows.

## Prerequisites
- AWS account with Bedrock model access enabled (Claude Sonnet 4.5, Amazon Nova Micro)
- Amazon Connect instance with a claimed phone number
- Deepgram account ($200 free credit)
- Google Cloud service account with Calendar access
- RDS PostgreSQL instance (or local for dev)

## First-Time Setup

1. Clone repo and install root deps: `npm install`
2. Copy `.env.example` to `.env` and fill in all values
3. Store secrets in SSM: see `infrastructure/template.yaml` for parameter names
4. Create database: `psql $DB_URL < db/schema.sql`
5. Deploy: `bash scripts/deploy.sh`
6. Configure Amazon Connect Contact Flow with the Lambda ARN from SAM outputs
7. Call your Connect phone number

## Local Testing

`bash scripts/test-call.sh`

## Architecture

Legacy path:
Inbound call → Telnyx Call Control → EC2 bridge → Deepgram Voice Agent

Migration path:
Inbound call → Telnyx AI Assistant → assistant-webhooks Lambda → PostgreSQL / Google Calendar / Telnyx SMS

Shared services:
Post-call summary → Bedrock fallback + Telnyx conversation insights
Inbound SMS reply → sms-reply-handler Lambda → Mirza's phone + DB update
Dashboard → dashboard-api Lambda + Cognito + Amplify

## LLM Provider Strategy

- **Conversation (Deepgram managed)**: `anthropic` / `claude-sonnet-4-5` — no credentials needed
- **TTS (Voice Agent)**: default Deepgram Aura-2, or set `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` to use ElevenLabs primary with Deepgram fallback
- **Mid-call swaps (UpdateThink)**: Deepgram-managed providers by call phase
- **Orchestrator (Bedrock)**: `amazon.nova-micro-v1:0` — fast classification
- **Post-call summary (Bedrock)**: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`

## Telnyx Assistant Rollout

1. Deploy AWS and apply database migrations.
2. Create the assistant and its insight group:
   `npm run assistant:setup:dev`
3. Assign a shadow number:
   `npm run assistant:shadow:dev`
4. Run the Telnyx assistant tests:
   `npm run assistant:test:dev`
5. Cut over the primary number only after the shadow-number bake-in:
   `npm run assistant:cutover:prod`
6. Place one real inbound call, then verify conversation creation, message flow, and Lambda event delivery:
   `npm run assistant:verify:prod`
7. Roll back instantly if needed:
   `npm run assistant:rollback:prod`
