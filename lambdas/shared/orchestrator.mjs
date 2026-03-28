/**
 * Layer 4: Conversation Orchestrator
 *
 * Fires on every user utterance. Returns JSON commands for STT, LLM, TTS,
 * tool hints, and phase transitions. Most turns return all-null (no change).
 *
 * Uses Amazon Nova Micro on Bedrock for fast classification.
 * Runtime changes are advisory-first. We only send messages that are confirmed
 * by the current Deepgram Voice Agent API used by this project.
 */

import { invokeModel } from './bedrock.mjs';

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

You will be called after every utterance. You must respond in valid JSON only. No prose. No explanation. No markdown.

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
    "provider": "anthropic | open_ai | null",
    "model": null,
    "prompt_variant": "greeting | scheduling | faq | rag | closing | null"
  },
  "tts_update": {
    "update": false,
    "model": "aura-2-thalia-en | elevenlabs | null"
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

LLM ROUTING (Deepgram managed providers):
greeting/closing: provider anthropic, model claude-4-5-haiku-latest
scheduling: provider anthropic, model claude-sonnet-4-5
faq with rag: provider anthropic, model claude-sonnet-4-5, variant rag
faq without rag: provider open_ai, model gpt-4o-mini

TTS: Use elevenlabs only for legal/dental vertical FAQ turns or when caller_skeptical=true. All other turns use aura-2-thalia-en.

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
 * Call the orchestrator via Bedrock (Amazon Nova Micro) and return parsed commands.
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
    const text = await invokeModel(JSON.stringify(input), {
      modelId:      process.env.BEDROCK_ORCHESTRATOR_MODEL_ID || 'amazon.nova-micro-v1:0',
      maxTokens:    400,
      temperature:  0,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    });

    const parsed = JSON.parse(text.trim());
    console.log('[ORCHESTRATOR]', parsed.reasoning);
    return parsed;

  } catch (err) {
    console.warn('[ORCHESTRATOR] Failed, returning no-change:', err.message);
    return NO_CHANGE;
  }
}

/**
 * Apply orchestrator commands to the Deepgram WebSocket and call state.
 * For stability, unsupported runtime mutations are logged and skipped.
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

  // Deepgram handles barge-in automatically for the active session. We do not
  // send an extra control message here because `Clear` is not part of the
  // current confirmed Agent API surface.
  if (commands.interrupt_action === 'clear_buffer') {
    console.log('[ORCHESTRATOR] Interrupt requested; relying on Deepgram barge-in handling');
    return;
  }

  // Runtime STT mutation is disabled until we adopt a confirmed Agent API
  // message for live listen reconfiguration.
  if (commands.stt_config?.update) {
    console.log('[ORCHESTRATOR] STT update requested but skipped for compatibility');
  }

  // Runtime provider/model swaps are disabled until we adopt a confirmed Agent
  // API message for think updates. The base session prompt still handles the
  // conversation correctly, so skipping this is safer than sending stale
  // protocol messages that can terminate the session.
  if (commands.llm_update?.update) {
    console.log(
      '[ORCHESTRATOR] LLM update requested but skipped for compatibility:',
      commands.llm_update.provider,
      commands.llm_update.model
    );
  }

  // Runtime TTS swaps are disabled until we send the full provider payload for
  // the current API. The initial session voice is stable and known-good.
  if (commands.tts_update?.update) {
    console.log('[ORCHESTRATOR] TTS update requested but skipped for compatibility:', commands.tts_update.model);
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
