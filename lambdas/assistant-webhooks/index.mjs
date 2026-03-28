import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { setTimeout as sleep } from 'node:timers/promises';
import { query } from '../shared/db.mjs';
import { executeBusinessTool } from '../shared/tool-actions.mjs';
import {
  sendPostCallSms,
  summarizeTranscriptWithBedrock,
} from '../shared/post-call.mjs';
import { buildAssistantDynamicVariables } from '../shared/telnyx-assistant.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Aria-Assistant-Secret,X-Telnyx-Assistant-Secret',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const TELNYX_API_ROOT = 'https://api.telnyx.com/v2';
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
let cachedWebhookSecret = null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function getSecret(event) {
  return (
    event.queryStringParameters?.secret ||
    getHeader(event, 'x-aria-assistant-secret') ||
    getHeader(event, 'x-telnyx-assistant-secret') ||
    ''
  );
}

async function getConfiguredSecret() {
  if (cachedWebhookSecret !== null) {
    return cachedWebhookSecret;
  }

  if (process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET) {
    cachedWebhookSecret = process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET;
    return cachedWebhookSecret;
  }

  if (!process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET_PARAM) {
    cachedWebhookSecret = '';
    return cachedWebhookSecret;
  }

  const response = await ssm.send(
    new GetParameterCommand({
      Name: process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET_PARAM,
      WithDecryption: true,
    })
  );
  cachedWebhookSecret = response.Parameter?.Value || '';
  return cachedWebhookSecret;
}

function normalizePath(rawPath = '') {
  return rawPath.replace(/^\/[^/]+(?=\/assistant\/)/, '');
}

function parseJsonBody(event) {
  if (!event.body) {
    return {};
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    return JSON.parse(raw);
  } catch (error) {
    const contentType = getHeader(event, 'content-type') || '';
    if (
      contentType.includes('application/x-www-form-urlencoded') ||
      raw.includes('=')
    ) {
      return Object.fromEntries(new URLSearchParams(raw));
    }

    console.error('[ASSISTANT WEBHOOKS] Failed to parse JSON body', error);
    return {};
  }
}

function pickFirstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeContextValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\{\{.+\}\}$/.test(trimmed)) {
    return undefined;
  }

  if (['unknown', 'null', 'undefined'].includes(trimmed.toLowerCase())) {
    return undefined;
  }

  return trimmed;
}

function pickFirstContextValue(...values) {
  for (const value of values) {
    const normalized = normalizeContextValue(value);
    if (normalized !== undefined && normalized !== null && normalized !== '') {
      return normalized;
    }
  }
  return undefined;
}

function extractConversationContext(event, body = {}) {
  const payload = body.data?.payload || body.payload || body;
  const queryString = event.queryStringParameters || {};

  return {
    assistantId: pickFirstContextValue(
      body.assistant_id,
      body.assistantId,
      body.data?.assistant_id,
      payload.assistant_id
    ),
    conversationId: pickFirstContextValue(
      queryString.conversation_id,
      body.telnyx_conversation_id,
      body.conversation_id,
      payload.conversation_id,
      payload.telnyx_conversation_id
    ),
    callControlId: pickFirstContextValue(
      queryString.call_control_id,
      body.call_control_id,
      body.callControlId,
      body.CallSid,
      payload.call_control_id,
      getHeader(event, 'x-telnyx-call-control-id')
    ),
    phoneNumber: pickFirstContextValue(
      queryString.phone_number,
      body.phone_number,
      body.telnyx_end_user_target,
      body.From,
      payload.phone_number,
      payload.telnyx_end_user_target,
      payload.from,
      payload.caller_id_number
    ),
    startedAt: pickFirstContextValue(
      payload.started_at,
      payload.call_started_at,
      body.started_at,
      body.created_at
    ),
    endedAt: pickFirstContextValue(
      payload.ended_at,
      payload.completed_at,
      body.ended_at
    ),
    durationSeconds: pickFirstContextValue(
      payload.duration_seconds,
      payload.duration_secs,
      body.duration_seconds,
      body.duration_secs
    ),
  };
}

async function fetchLatestLeadByPhone(phoneNumber) {
  if (!phoneNumber) {
    return null;
  }

  const result = await query(
    `SELECT *
       FROM leads
      WHERE phone_number = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [phoneNumber]
  );

  return result.rows[0] || null;
}

function formatPriorContext(lead) {
  if (!lead) {
    return '';
  }

  const details = [
    lead.first_name ? `name: ${lead.first_name}` : null,
    lead.business_name ? `business: ${lead.business_name}` : null,
    lead.business_type ? `business type: ${lead.business_type}` : null,
    lead.callback_day || lead.callback_time
      ? `callback preference: ${lead.callback_day || 'unknown day'} ${lead.callback_time || ''}`.trim()
      : null,
  ].filter(Boolean);

  if (!details.length) {
    return 'Returning caller with limited prior context.';
  }

  return `Returning caller. Known details: ${details.join(', ')}.`;
}

async function upsertAssistantCallRecord(context, lead = null) {
  const contactId =
    context.callControlId ||
    context.conversationId ||
    `assistant-${Date.now()}`;
  const conversationId = context.conversationId || null;
  const startedAt = context.startedAt || new Date().toISOString();

  let existing = null;
  if (conversationId) {
    const result = await query(
      `SELECT *
         FROM calls
        WHERE conversation_id = $1
        LIMIT 1`,
      [conversationId]
    );
    existing = result.rows[0] || null;
  } else if (contactId) {
    const result = await query(
      `SELECT *
         FROM calls
        WHERE contact_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [contactId]
    );
    existing = result.rows[0] || null;
  }

  if (existing) {
    const result = await query(
      `UPDATE calls
          SET contact_id = $2,
              conversation_id = COALESCE($3, conversation_id),
              phone_number = COALESCE($4, phone_number),
              lead_id = COALESCE($5, lead_id),
              runtime_provider = 'telnyx_ai_assistant',
              started_at = COALESCE(started_at, $6)
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        contactId,
        conversationId,
        context.phoneNumber || existing.phone_number,
        lead?.id || existing.lead_id,
        startedAt,
      ]
    );
    return result.rows[0];
  }

  const inserted = await query(
    `INSERT INTO calls (
       contact_id,
       conversation_id,
       lead_id,
       phone_number,
       runtime_provider,
       started_at
     )
     VALUES ($1, $2, $3, $4, 'telnyx_ai_assistant', $5)
     RETURNING *`,
    [contactId, conversationId, lead?.id || null, context.phoneNumber || '', startedAt]
  );

  return inserted.rows[0];
}

async function telnyxRequest(path) {
  const response = await fetch(`${TELNYX_API_ROOT}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telnyx API request failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function fetchConversationMessages(conversationId) {
  if (!conversationId) {
    return [];
  }

  const messages = [];
  let pageNumber = 1;
  let totalPages = 1;

  do {
    const response = await telnyxRequest(
      `/ai/conversations/${conversationId}/messages?page[number]=${pageNumber}&page[size]=100`
    );
    messages.push(...(response.data || []));
    totalPages = response.meta?.total_pages || 1;
    pageNumber += 1;
  } while (pageNumber <= totalPages);

  return messages;
}

async function fetchConversation(conversationId) {
  if (!conversationId) {
    return null;
  }

  const response = await telnyxRequest(`/ai/conversations/${conversationId}`);
  return response.data || null;
}

async function fetchConversationMessagesWithRetry(conversationId, expectedCount = 0) {
  const attempts = expectedCount > 0 ? 3 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const messages = await fetchConversationMessages(conversationId);
    if (messages.length > 0 || attempt === attempts) {
      return messages;
    }

    await sleep(400);
  }

  return [];
}

async function fetchConversationInsights(conversationId) {
  if (!conversationId) {
    return [];
  }
  const response = await telnyxRequest(
    `/ai/conversations/${conversationId}/conversations-insights`
  );
  return response.data || [];
}

function conversationMessagesToTranscript(messages) {
  const lines = [];
  const toolsUsed = new Set();

  for (const message of messages) {
    if (message.role && message.text) {
      lines.push(`${message.role}: ${message.text}`);
    }
    for (const toolCall of message.tool_calls || []) {
      if (toolCall.function?.name) {
        toolsUsed.add(toolCall.function.name);
      }
    }
  }

  return {
    transcript: lines.join('\n'),
    toolsUsed: Array.from(toolsUsed),
  };
}

function parseInsightResult(result) {
  if (!result) {
    return null;
  }

  if (typeof result === 'object') {
    return result;
  }

  try {
    return JSON.parse(result);
  } catch {
    return { summary: result };
  }
}

function normalizeInsights(conversationInsights = [], eventBody = {}) {
  const parsed = [];
  const seenResults = new Set();

  const pushInsight = (insight) => {
    const result = parseInsightResult(insight?.result);
    if (!result) {
      return;
    }

    const fingerprint = JSON.stringify(result);
    if (seenResults.has(fingerprint)) {
      return;
    }

    seenResults.add(fingerprint);
    parsed.push({
      insight_id: insight?.insight_id || insight?.id || null,
      result,
    });
  };

  for (const insightSet of conversationInsights) {
    for (const insight of insightSet.conversation_insights || []) {
      pushInsight(insight);
    }
  }

  for (const insight of eventBody.insights || []) {
    pushInsight(insight);
  }

  for (const insight of eventBody.data?.payload?.results || []) {
    pushInsight(insight);
  }

  for (const insight of eventBody.payload?.results || []) {
    pushInsight(insight);
  }

  return parsed;
}

function deriveOutcome({ toolsUsed = [], lead, summaryPayload }) {
  if (toolsUsed.includes('book_appointment')) {
    return 'appointment_booked';
  }
  if (toolsUsed.includes('transfer_call') || toolsUsed.includes('transfer')) {
    return 'transferred';
  }
  if (summaryPayload?.lead_quality === 'hot') {
    return 'hot_lead';
  }
  if (lead || toolsUsed.includes('log_lead')) {
    return 'lead_captured';
  }
  return 'completed';
}

function deriveDurationSeconds(startedAt, endedAt) {
  if (!startedAt || !endedAt) {
    return undefined;
  }

  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  return Math.round(durationMs / 1000);
}

async function persistConversationSummary(call, lead, transcript, toolsUsed, insights, context) {
  let summaryPayload =
    insights.find((item) => item.result?.summary)?.result ||
    insights[0]?.result ||
    null;

  if (!summaryPayload && transcript) {
    try {
      summaryPayload = await summarizeTranscriptWithBedrock(transcript);
    } catch (error) {
      console.error('[ASSISTANT EVENTS] Bedrock fallback failed', error);
    }
  }

  const summaryText = summaryPayload ? JSON.stringify(summaryPayload) : null;
  const outcome = deriveOutcome({ toolsUsed, lead, summaryPayload });

  const updated = await query(
    `UPDATE calls
        SET contact_id = COALESCE($2, contact_id),
            conversation_id = COALESCE($3, conversation_id),
            lead_id = COALESCE($4, lead_id),
            phone_number = COALESCE($5, phone_number),
            duration_seconds = COALESCE($6, duration_seconds),
            transcript = COALESCE($7, transcript),
            summary = COALESCE($8, summary),
            tools_used = CASE
              WHEN $9::text[] IS NULL OR array_length($9::text[], 1) IS NULL THEN tools_used
              ELSE $9::text[]
            END,
            outcome = COALESCE($10, outcome),
            ended_at = COALESCE($11, ended_at),
            runtime_provider = 'telnyx_ai_assistant'
      WHERE id = $1
      RETURNING *`,
    [
      call.id,
      context.callControlId,
      context.conversationId,
      lead?.id || call.lead_id,
      context.phoneNumber || call.phone_number,
      context.durationSeconds ? parseInt(context.durationSeconds, 10) : null,
      transcript || null,
      summaryText,
      toolsUsed.length ? toolsUsed : null,
      outcome,
      context.endedAt || null,
    ]
  );

  if (summaryPayload?.business_type && lead?.id) {
    await query(
      `UPDATE leads
          SET business_type = COALESCE(business_type, $2),
              updated_at = NOW()
        WHERE id = $1`,
      [lead.id, summaryPayload.business_type]
    );
  }

  return updated.rows[0];
}

async function handleDynamicVariables(event) {
  const body = parseJsonBody(event);
  const context = extractConversationContext(event, body);
  const lead = await fetchLatestLeadByPhone(context.phoneNumber);
  await upsertAssistantCallRecord(context, lead);

  const defaults = buildAssistantDynamicVariables();
  return json(200, {
    dynamic_variables: {
      ...defaults,
      first_name: lead?.first_name || '',
      business_name: lead?.business_name || '',
      business_type: lead?.business_type || '',
      prior_context: formatPriorContext(lead),
      booking_link: process.env.BOOKING_LINK || defaults.booking_link,
      transfer_timezone:
        process.env.HUMAN_TRANSFER_TIMEZONE || defaults.transfer_timezone,
      transfer_hours: defaults.transfer_hours,
      agent_name: process.env.DEMO_AGENT_NAME || defaults.agent_name,
      demo_business_name:
        process.env.DEMO_BUSINESS_NAME || defaults.demo_business_name,
    },
    conversation: {
      metadata: {
        assistant_id: context.assistantId || '',
        call_control_id: context.callControlId || '',
        telnyx_end_user_target: context.phoneNumber || '',
      },
    },
  });
}

async function handleTool(toolName, event) {
  const body = parseJsonBody(event);
  const args = body.arguments || body.args || body;
  const context = extractConversationContext(event, body);

  const result = await executeBusinessTool(toolName, args, context);
  return json(200, result);
}

async function handleEvents(event) {
  const body = parseJsonBody(event);
  const eventType = pickFirstValue(
    body.data?.event_type,
    body.event_type,
    body.type,
    body.CallStatus ? `texml.call.${String(body.CallStatus).toLowerCase()}` : undefined
  );
  let context = extractConversationContext(event, body);
  const conversation = context.conversationId
    ? await fetchConversation(context.conversationId)
    : null;

  if (conversation) {
    const metadata = conversation.metadata || {};
    const startedAt = context.startedAt || conversation.created_at;
    const endedAt = context.endedAt || conversation.last_message_at;
    const durationSeconds =
      context.durationSeconds ||
      deriveDurationSeconds(startedAt, endedAt);

    context = {
      ...context,
      assistantId: context.assistantId || metadata.assistant_id,
      callControlId: context.callControlId || metadata.call_control_id,
      phoneNumber:
        context.phoneNumber ||
        metadata.telnyx_end_user_target ||
        metadata.from ||
        metadata.to,
      startedAt,
      endedAt,
      durationSeconds,
    };
  }

  if (!context.phoneNumber && !context.conversationId && !context.callControlId) {
    return json(200, { ok: true, ignored: true, reason: 'No conversation context' });
  }

  if (eventType?.startsWith('texml.call.') && !context.conversationId) {
    return json(200, {
      ok: true,
      ignored: true,
      reason: 'TeXML status callback without conversation id',
      event_type: eventType,
    });
  }

  const lead = await fetchLatestLeadByPhone(context.phoneNumber);
  const call = await upsertAssistantCallRecord(context, lead);

  const shouldFetchTranscript =
    !eventType ||
    eventType === 'call.conversation.ended' ||
    eventType === 'call.conversation_insights.generated' ||
    eventType === 'conversation.insights.completed' ||
    eventType === 'conversation_insight_result';
  const messages = shouldFetchTranscript
    ? await fetchConversationMessagesWithRetry(
        context.conversationId,
        conversation?.number_of_messages || 0
      )
    : [];
  const { transcript, toolsUsed } = conversationMessagesToTranscript(messages);

  const directInsights = normalizeInsights([], body);
  const insights =
    directInsights.length > 0
      ? directInsights
      : eventType === 'call.conversation_insights.generated' ||
          eventType === 'call.conversation.ended'
        ? normalizeInsights(
            await fetchConversationInsights(context.conversationId),
            body
          )
        : [];

  const updatedCall = await persistConversationSummary(
    call,
    lead,
    transcript,
    toolsUsed,
    insights,
    context
  );

  console.log('[ASSISTANT EVENTS] handled', {
    event_type: eventType || 'unknown',
    conversation_id: context.conversationId || null,
    call_control_id: context.callControlId || null,
    call_id: updatedCall.id,
    transcript_messages: messages.length,
    insights: insights.length,
  });

  if (
    eventType === 'call.conversation.ended' ||
    eventType === 'call.conversation_insights.generated' ||
    eventType === 'conversation.insights.completed' ||
    eventType === 'conversation_insight_result'
  ) {
    try {
      await sendPostCallSms(updatedCall, lead);
    } catch (error) {
      console.error('[ASSISTANT EVENTS] Post-call SMS failed', error);
    }
  }

  return json(200, {
    ok: true,
    event_type: eventType || 'unknown',
    conversation_id: context.conversationId,
    call_id: updatedCall.id,
  });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'POST';
  const path = normalizePath(event.rawPath || '/');

  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: '',
    };
  }

  const configuredSecret = await getConfiguredSecret();
  if (configuredSecret && getSecret(event) !== configuredSecret) {
    return json(401, { error: 'Unauthorized' });
  }

  try {
    if (path === '/assistant/dynamic-variables') {
      return await handleDynamicVariables(event);
    }

    if (path.startsWith('/assistant/tools/')) {
      const toolName = path.split('/').pop().replace(/-/g, '_');
      return await handleTool(toolName, event);
    }
    if (path === '/assistant/events') {
      return await handleEvents(event);
    }

    return json(404, { error: 'Not found' });
  } catch (error) {
    console.error('[ASSISTANT WEBHOOKS ERROR]', error);
    return json(500, {
      error: 'Internal server error',
      message: error.message,
    });
  }
};
