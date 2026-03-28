#!/usr/bin/env node
import {
  buildAssistantEventsUrl,
  buildAssistantPayload,
} from '../lambdas/shared/telnyx-assistant.mjs';
import { getStackOutput, loadEnvFile, requireEnv, upsertEnvFile } from './_env.mjs';

const environment = process.argv[2] || 'dev';
const envFile = loadEnvFile(environment);
const region = process.env.AWS_REGION || 'us-east-1';
const stackName = `aria-${environment}`;

requireEnv(['TELNYX_API_KEY', 'TELNYX_ASSISTANT_WEBHOOK_SECRET']);

const INSIGHT_GROUP_NAME = `aria-${environment}-post-call-insights`;
const INSIGHT_NAME = `aria-${environment}-call-summary`;
const INSIGHT_DESCRIPTION = 'Post-call summaries and outcomes for Aria demo calls.';
const INSIGHT_INSTRUCTIONS =
  'Summarize the conversation and output JSON with keys summary, lead_quality, next_action, business_type, pain_points, and outcome. Keep summary concise and practical for CRM follow-up.';
const INSIGHT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    lead_quality: {
      type: 'string',
      enum: ['hot', 'warm', 'cold'],
    },
    next_action: { type: 'string' },
    business_type: { type: 'string' },
    pain_points: {
      type: 'array',
      items: { type: 'string' },
    },
    outcome: { type: 'string' },
  },
  required: [
    'summary',
    'lead_quality',
    'next_action',
    'business_type',
    'pain_points',
    'outcome',
  ],
};

async function telnyxRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Telnyx API ${method} ${path} failed (${response.status}): ${text}`);
  }

  return data;
}

async function listAll(path) {
  const results = [];
  let pageNumber = 1;
  let totalPages = 1;

  do {
    const separator = path.includes('?') ? '&' : '?';
    const response = await telnyxRequest(
      `${path}${separator}page[number]=${pageNumber}&page[size]=100`
    );
    results.push(...(response.data || []));
    totalPages = response.meta?.total_pages || 1;
    pageNumber += 1;
  } while (pageNumber <= totalPages);

  return results;
}

function extractAssistantToolNames(tools = []) {
  return tools.map((tool) => {
    if (tool.webhook?.name) {
      return tool.webhook.name;
    }

    if (tool.type === 'transfer') {
      return 'transfer';
    }

    if (tool.type === 'hangup') {
      return 'hangup';
    }

    return tool.type || 'unknown';
  });
}

async function ensureInsightGroup(eventsUrl) {
  const groupIdFromEnv = process.env.TELNYX_ASSISTANT_INSIGHT_GROUP_ID;
  const existingGroups = await listAll('/ai/conversations/insight-groups');
  let existingGroup =
    existingGroups.find((group) => group.id === groupIdFromEnv) ||
    existingGroups.find((group) => group.name === INSIGHT_GROUP_NAME);

  if (!existingGroup) {
    const createdGroup = await telnyxRequest('/ai/conversations/insight-groups', {
      method: 'POST',
      body: {
        name: INSIGHT_GROUP_NAME,
        description: INSIGHT_DESCRIPTION,
        webhook: eventsUrl,
      },
    });
    existingGroup = createdGroup.data || createdGroup;
  } else if (existingGroup.webhook !== eventsUrl) {
    const updatedGroup = await telnyxRequest(
      `/ai/conversations/insight-groups/${existingGroup.id}`,
      {
        method: 'PUT',
        body: {
          name: existingGroup.name || INSIGHT_GROUP_NAME,
          description: existingGroup.description || INSIGHT_DESCRIPTION,
          webhook: eventsUrl,
        },
      }
    );
    existingGroup = {
      ...existingGroup,
      ...(updatedGroup.data || updatedGroup),
    };
  }

  const matchingInsights = (existingGroup.insights || []).filter(
    (insight) => insight.name === INSIGHT_NAME
  );
  const existingInsight = matchingInsights[0];

  if (matchingInsights.length > 1) {
    console.warn(
      `Insight group ${existingGroup.id} already has ${matchingInsights.length} copies of ${INSIGHT_NAME}; reusing the first one and skipping new assignments.`
    );
  }

  let insightId = existingInsight?.id;
  if (!insightId) {
    const createdInsight = await telnyxRequest('/ai/conversations/insights', {
      method: 'POST',
      body: {
        name: INSIGHT_NAME,
        instructions: INSIGHT_INSTRUCTIONS,
        json_schema: INSIGHT_JSON_SCHEMA,
      },
    });

    insightId = createdInsight.data?.id || createdInsight.id;
    await telnyxRequest(
      `/ai/conversations/insight-groups/${existingGroup.id}/insights/${insightId}/assign`,
      {
        method: 'POST',
      }
    );
  }

  return {
    groupId: existingGroup.id,
    insightId,
  };
}

async function ensureTeXMLStatusCallback(texmlAppId, eventsUrl) {
  if (!texmlAppId) {
    return null;
  }

  const response = await telnyxRequest(`/texml_applications/${texmlAppId}`);
  const app = response.data || response;

  if (
    app.status_callback === eventsUrl &&
    String(app.status_callback_method || '').toLowerCase() === 'post'
  ) {
    return app;
  }

  const updated = await telnyxRequest(`/texml_applications/${texmlAppId}`, {
    method: 'PATCH',
    body: {
      friendly_name: app.friendly_name,
      voice_url: app.voice_url,
      active: app.active,
      voice_fallback_url: app.voice_fallback_url,
      voice_method: String(app.voice_method || 'get').toLowerCase(),
      status_callback: eventsUrl,
      status_callback_method: 'post',
    },
  });

  return updated.data || updated;
}

function validateAssistant(assistant) {
  if (!assistant?.voice_settings?.voice) {
    throw new Error('Assistant validation failed: voice_settings.voice is missing.');
  }

  if (!assistant?.transcription?.model) {
    throw new Error('Assistant validation failed: transcription.model is missing.');
  }

  const expectedTools = [
    'log_lead',
    'send_sms',
    'get_available_slots',
    'book_appointment',
    'transfer',
    'hangup',
  ];
  const actualToolNames = extractAssistantToolNames(assistant.tools || []);
  const missingTools = expectedTools.filter(
    (toolName) => !actualToolNames.includes(toolName)
  );

  if (missingTools.length) {
    throw new Error(
      `Assistant validation failed: missing tools ${missingTools.join(', ')}.`
    );
  }
}

async function main() {
  const webhookBaseUrl =
    process.env.TELNYX_ASSISTANT_WEBHOOK_BASE_URL ||
    getStackOutput(stackName, 'AssistantWebhookUrl', region);
  const eventsUrl = buildAssistantEventsUrl(
    webhookBaseUrl,
    process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET
  );
  const { groupId: insightGroupId } = await ensureInsightGroup(eventsUrl);
  const payload = buildAssistantPayload({
    webhookBaseUrl,
    insightGroupId,
    secret: process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET,
  });

  const assistantId = process.env.TELNYX_ASSISTANT_ID;
  const response = assistantId
    ? await telnyxRequest(`/ai/assistants/${assistantId}`, {
        method: 'POST',
        body: {
          ...payload,
          promote_to_main: true,
        },
      })
    : await telnyxRequest('/ai/assistants', {
        method: 'POST',
        body: payload,
      });

  const assistant = response.data || response;
  const defaultTeXMLAppId =
    assistant.telephony_settings?.default_texml_app_id ||
    assistant.default_texml_app_id ||
    '';
  const texmlApp = await ensureTeXMLStatusCallback(defaultTeXMLAppId, eventsUrl);
  const validatedResponse = await telnyxRequest(`/ai/assistants/${assistant.id}`);
  const validatedAssistant = validatedResponse.data || validatedResponse;
  validateAssistant(validatedAssistant);

  if (!texmlApp?.status_callback) {
    throw new Error('TeXML app validation failed: status_callback is missing.');
  }

  upsertEnvFile(envFile, {
    TELNYX_ASSISTANT_ID: assistant.id,
    TELNYX_ASSISTANT_INSIGHT_GROUP_ID: insightGroupId,
    TELNYX_ASSISTANT_WEBHOOK_BASE_URL: webhookBaseUrl,
    TELNYX_ASSISTANT_TEXML_APP_ID: defaultTeXMLAppId,
  });

  console.log(`Assistant ready for ${environment}`);
  console.log(`Assistant ID: ${assistant.id}`);
  console.log(`Insight group ID: ${insightGroupId}`);
  console.log(`Webhook URL: ${webhookBaseUrl}`);
  console.log(
    `Events URL: ${webhookBaseUrl.replace(/\/+$/, '')}/assistant/events?secret=[configured]`
  );
  console.log(`Voice: ${validatedAssistant.voice_settings.voice}`);
  console.log(`Transcription model: ${validatedAssistant.transcription.model}`);
  console.log(
    `Tools: ${extractAssistantToolNames(validatedAssistant.tools || []).join(', ')}`
  );
  if (defaultTeXMLAppId) {
    console.log(`Default TeXML app ID: ${defaultTeXMLAppId}`);
  }
  console.log(
    `TeXML status callback: ${texmlApp?.status_callback ? '[configured]' : '[missing]'}`
  );
  console.log(`Saved assistant values to ${envFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
