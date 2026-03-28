/**
 * Aria EC2 Bridge Server
 * Handles Telnyx Call Control webhook + bidirectional audio streaming to Deepgram Voice Agent.
 *
 * HTTP  POST /telnyx/call-control  — Answers inbound call via Telnyx Call Control API
 * WS         /stream               — Bidirectional audio bridge: Telnyx ↔ Deepgram
 * GET        /health               — Health check
 *
 * Reuses all shared modules from lambdas/shared/ (db, deepgram, tools, orchestrator).
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { buildAgentSettings } from '../lambdas/shared/deepgram.mjs';
import { executeTool } from '../lambdas/shared/tools.mjs';
import { query } from '../lambdas/shared/db.mjs';
import {
  buildOrchestratorInput,
  runOrchestrator,
  applyOrchestratorCommands,
} from '../lambdas/shared/orchestrator.mjs';

const PORT        = process.env.PORT || 3000;
const DG_WS_URL   = 'wss://agent.deepgram.com/v1/agent/converse';
const EC2_WSS_URL = process.env.EC2_WSS_URL || 'wss://stream.bismillahtech.ai';
const MAX_BUFFERED_TELNYX_FRAMES = 250;
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'deepgram';
const ELEVENLABS_READY = !!(
  (process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY) &&
  (process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_LABS_VOICE_ID)
);

console.log('[ENV CHECK] DEEPGRAM_API_KEY:', process.env.DEEPGRAM_API_KEY ? `set (${process.env.DEEPGRAM_API_KEY.slice(0,8)}...)` : 'MISSING');
console.log('[ENV CHECK] TELNYX_API_KEY:', process.env.TELNYX_API_KEY ? 'set' : 'MISSING');
console.log('[ENV CHECK] EC2_WSS_URL:', EC2_WSS_URL);
console.log('[ENV CHECK] TTS_PROVIDER:', TTS_PROVIDER);
console.log('[ENV CHECK] ELEVENLABS:', ELEVENLABS_READY ? 'ready' : 'not configured');

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/telnyx/call-control') {
    // Call Control webhook — answer inbound calls with bidirectional stream
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        const { event_type, payload } = event.data;
        console.log('[CALL CONTROL]', event_type, payload?.call_control_id);

        if (event_type === 'call.initiated' && payload.direction === 'incoming') {
          const resp = await fetch(
            `https://api.telnyx.com/v2/calls/${payload.call_control_id}/actions/answer`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
                'Content-Type':  'application/json',
              },
              body: JSON.stringify({
                stream_url:                 `${EC2_WSS_URL}/stream`,
                stream_track:               'both_tracks',
                stream_bidirectional_mode:  'rtp',
                stream_bidirectional_codec: 'L16',
                stream_bidirectional_sampling_rate: 16000,
              }),
            }
          );
          if (!resp.ok) {
            const err = await resp.text();
            console.error('[CALL CONTROL] Answer failed:', resp.status, err);
          }
        }
      } catch (err) {
        console.error('[CALL CONTROL] Error:', err.message);
      }
      res.writeHead(200).end();
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (telnyxWs) => {
  console.log('[BRIDGE] Telnyx connected');

  const state = {
    transcriptParts: [],
    toolsUsed:       [],
    outcome:         'abandoned',
    leadId:          null,
    callerPhone:     '+10000000000',
    callDbId:        null,
    callPhase:       'greeting',
    leadData:        {},
    flags:           {},
    smsSent:         false,
    vertical:        'general',
    pendingToolHint: null,
    callControlId:   null,
    dgWelcomeReceived: false,
    dgSettingsApplied: false,
    pendingAudioFrames: [],
    droppedAudioFrames: 0,
    telnyxOutboundFrames: 0,
  };

  let dgWs    = null;
  let cleaned = false;

  const flushPendingAudioFrames = () => {
    if (!dgWs || dgWs.readyState !== WebSocket.OPEN || !state.dgSettingsApplied) {
      return;
    }
    if (state.pendingAudioFrames.length === 0) {
      return;
    }

    const bufferedCount = state.pendingAudioFrames.length;
    console.log('[AUDIO] Flushing buffered caller audio frames:', bufferedCount);
    for (const frame of state.pendingAudioFrames) {
      dgWs.send(frame);
    }
    state.pendingAudioFrames = [];
  };

  const queueOrForwardCallerAudio = (payload) => {
    const frame = Buffer.from(payload, 'base64');

    if (dgWs?.readyState === WebSocket.OPEN && state.dgSettingsApplied) {
      dgWs.send(frame);
      return;
    }

    if (state.pendingAudioFrames.length >= MAX_BUFFERED_TELNYX_FRAMES) {
      state.pendingAudioFrames.shift();
      state.droppedAudioFrames += 1;
    }

    state.pendingAudioFrames.push(frame);

    if (state.pendingAudioFrames.length === 1) {
      console.log('[AUDIO] Buffering caller audio until Deepgram session is ready');
    } else if (state.pendingAudioFrames.length % 50 === 0) {
      console.log('[AUDIO] Buffered caller audio frames:', state.pendingAudioFrames.length, 'dropped:', state.droppedAudioFrames);
    }
  };

  const cleanup = async (reason) => {
    if (cleaned) return;
    cleaned = true;
    console.log('[CLEANUP]', reason);

    if (dgWs?.readyState === WebSocket.OPEN) dgWs.close();
    state.pendingAudioFrames = [];

    // Persist final call state to DB
    if (state.callDbId) {
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
            state.callDbId,
          ]
        );
      } catch (err) {
        console.warn('[DB] Failed to persist call end:', err.message);
      }
    }

    // Trigger post-call Lambda via Function URL
    const postCallUrl = process.env.POST_CALL_HANDLER_URL;
    if (postCallUrl && state.callDbId) {
      try {
        await fetch(postCallUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            contactId:   state.callDbId,
            callerPhone: state.callerPhone,
          }),
        });
      } catch (err) {
        console.warn('[POST-CALL] Failed to trigger:', err.message);
      }
    }
  };

  // ── Telnyx message handler ─────────────────────────────────────────────────

  telnyxWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {

      case 'connected':
        console.log('[TELNYX] Stream connected');
        break;

      case 'start': {
        const startData     = msg.start || {};
        state.callControlId = startData.call_control_id || null;
        state.callerPhone   = startData.from || '+10000000000';
        console.log('[TELNYX] Stream started, call_control_id:', state.callControlId, 'from:', state.callerPhone);

        // Open Deepgram WebSocket FIRST — don't block on DB queries
        const agentSettings = buildAgentSettings(state.callerPhone, null);
        const dgApiKey = process.env.DEEPGRAM_API_KEY;
        console.log('[DEEPGRAM] Connecting to', DG_WS_URL, 'with key:', dgApiKey ? `${dgApiKey.slice(0,8)}...` : 'MISSING');
        dgWs = new WebSocket(DG_WS_URL, {
          headers: { Authorization: `Token ${dgApiKey}` },
        });

        dgWs.on('open', () => {
          console.log('[DEEPGRAM] WebSocket open, waiting for Welcome before sending settings');
        });

        dgWs.on('unexpected-response', (_req, res) => {
          console.error('[DEEPGRAM] Unexpected upgrade response:', res.statusCode, JSON.stringify(res.headers));
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            console.error('[DEEPGRAM] Unexpected response body:', body.slice(0, 500));
          });
        });

        dgWs.on('message', async (dgRaw, isBinary) => {
          // Deepgram sends both text events and binary audio frames over the same
          // WebSocket. In `ws@8`, text frames may still arrive as Buffer objects,
          // so we must use `isBinary` rather than `instanceof Buffer`.
          if (isBinary) {
            if (telnyxWs.readyState === WebSocket.OPEN) {
              state.telnyxOutboundFrames += 1;
              if (state.telnyxOutboundFrames === 1 || state.telnyxOutboundFrames % 50 === 0) {
                console.log('[TELNYX AUDIO OUT] frames:', state.telnyxOutboundFrames, 'bytes:', dgRaw.length);
              }
              telnyxWs.send(JSON.stringify({
                event: 'media',
                media: { payload: dgRaw.toString('base64') },
              }));
            }
            return;
          }

          let dgMsg;
          try {
            const text = Buffer.isBuffer(dgRaw) ? dgRaw.toString() : String(dgRaw);
            dgMsg = JSON.parse(text);
          } catch {
            console.warn('[DEEPGRAM] Failed to parse text message:', Buffer.isBuffer(dgRaw) ? dgRaw.toString().slice(0, 200) : String(dgRaw).slice(0, 200));
            return;
          }

          console.log('[DG MSG]', dgMsg.type, JSON.stringify(dgMsg).slice(0, 200));

          switch (dgMsg.type) {

            case 'Welcome':
              state.dgWelcomeReceived = true;
              console.log('[DEEPGRAM] Welcome received, request_id:', dgMsg.request_id, '— sending settings now');
              dgWs.send(JSON.stringify(agentSettings));
              break;

            case 'SettingsApplied':
              state.dgSettingsApplied = true;
              console.log('[DEEPGRAM] Settings applied, agent active');
              flushPendingAudioFrames();
              break;

            case 'UserStartedSpeaking':
              // Deepgram detects the interruption, but Telnyx may still have
              // previously queued outbound audio buffered for playback.
              if (telnyxWs.readyState === WebSocket.OPEN) {
                telnyxWs.send(JSON.stringify({ event: 'clear' }));
                console.log('[TELNYX AUDIO OUT] Sent clear for barge-in');
              }
              break;

            case 'ConversationText':
              if (dgMsg.role && dgMsg.content) {
                state.transcriptParts.push(`${dgMsg.role.toUpperCase()}: ${dgMsg.content}`);
              }
              if (dgMsg.role === 'user') {
                try {
                  const orchInput = buildOrchestratorInput(state, dgMsg);
                  const commands  = await runOrchestrator(orchInput);
                  await applyOrchestratorCommands(dgWs, commands, state);
                } catch (err) {
                  console.warn('[ORCHESTRATOR] Error (non-fatal):', err.message);
                }
              }
              break;

            case 'FunctionCallRequest': {
              // New Deepgram format: { functions: [{ id, name, arguments, client_side }] }
              const functions = dgMsg.functions || [];
              for (const fn of functions) {
                const { id: fnCallId, name: fnName, arguments: fnArgs } = fn;
                state.toolsUsed.push(fnName);

                let toolArgs;
                try {
                  toolArgs = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : (fnArgs || {});
                } catch {
                  toolArgs = {};
                }

                // Inject call_control_id for transfer_call
                if (fnName === 'transfer_call') {
                  toolArgs.call_control_id = state.callControlId;
                }

                const result = await executeTool(fnName, toolArgs);

                // Update local state from tool results
                try {
                  const parsed = JSON.parse(result);
                  if (parsed.lead_id) state.leadId = parsed.lead_id;
                  if (parsed.success && fnName === 'log_lead') {
                    state.outcome = 'lead_captured';
                    if (toolArgs.first_name)    state.leadData.first_name    = toolArgs.first_name;
                    if (toolArgs.business_name) state.leadData.business_name = toolArgs.business_name;
                    if (toolArgs.business_type) {
                      state.leadData.business_type = toolArgs.business_type;
                      state.vertical = toolArgs.business_type.toLowerCase();
                    }
                    if (toolArgs.callback_time) state.leadData.callback_time = toolArgs.callback_time;
                    if (toolArgs.callback_day)  state.leadData.callback_day  = toolArgs.callback_day;
                  }
                  if (parsed.success && fnName === 'transfer_call') state.outcome = 'transferred';
                  if (parsed.success && fnName === 'send_sms')      state.smsSent = true;
                  if (parsed.success && fnName === 'book_appointment') {
                    state.leadData.appointment_id = parsed.event_id;
                  }
                } catch {}

                dgWs.send(JSON.stringify({
                  type:    'FunctionCallResponse',
                  id:      fnCallId,
                  name:    fnName,
                  content: result,
                }));
              }
              break;
            }

            case 'AgentAudioDone':
              break;

            case 'Close':
              await cleanup('Deepgram closed session');
              break;

            case 'Error':
              console.error('[DEEPGRAM ERROR]', dgMsg);
              await cleanup('Deepgram error');
              break;
          }
        });

        dgWs.on('error', async (err) => {
          console.error('[DEEPGRAM WS ERROR]', err.message || err);
          await cleanup('Deepgram WebSocket error');
        });

        dgWs.on('close', async (code, reason) => {
          console.log('[DEEPGRAM] WebSocket closed, code:', code, 'reason:', reason?.toString());
          await cleanup('Deepgram WebSocket closed');
        });

        // Safety timeout — 12 min per call
        setTimeout(() => cleanup('Max call duration reached'), 12 * 60 * 1000);

        // Run DB queries in background — don't block audio pipeline
        (async () => {
          let existingLead = null;
          try {
            const res = await query(
              `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
              [state.callerPhone]
            );
            if (res.rows.length) {
              existingLead   = res.rows[0];
              state.leadId   = existingLead.id;
              state.leadData = { ...existingLead };
              state.vertical = existingLead.business_type?.toLowerCase() || 'general';
              console.log('[MEMORY] Returning caller:', existingLead.first_name);
            }
          } catch (err) {
            console.warn('[MEMORY] DB lookup failed:', err.message);
          }

          try {
            const res = await query(
              `INSERT INTO calls (contact_id, phone_number, lead_id, started_at)
               VALUES ($1, $2, $3, NOW()) RETURNING id`,
              [state.callControlId, state.callerPhone, existingLead?.id || null]
            );
            state.callDbId = res.rows[0].id;
          } catch (err) {
            console.warn('[DB] Failed to log call start:', err.message);
          }
        })();

        break;
      }

      case 'media': {
        // Caller audio — queue until Deepgram confirms SettingsApplied, then stream raw bytes.
        if (msg.media?.payload) {
          queueOrForwardCallerAudio(msg.media.payload);
        }
        break;
      }

      case 'stop':
        console.log('[TELNYX] Stream stop event received');
        await cleanup('Telnyx stream stopped');
        break;

      case 'error':
        console.error('[TELNYX STREAM ERROR]', JSON.stringify(msg));
        break;
    }
  });

  telnyxWs.on('error', (err) => {
    console.error('[TELNYX WS ERROR]', err);
  });

  telnyxWs.on('close', async () => {
    await cleanup('Telnyx WebSocket closed');
  });
});

server.listen(PORT, () => {
  console.log(`[ARIA BRIDGE] Listening on port ${PORT}`);
});
