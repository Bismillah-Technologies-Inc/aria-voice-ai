import { TOOL_SCHEMAS } from './tools.mjs';

export const TELNYX_ASSISTANT_DEFAULTS = {
  model: 'anthropic/claude-haiku-4-5',
  voice: 'Telnyx.NaturalHD.astra',
  voiceSpeed: 0.95,
  transcriptionModel: 'deepgram/nova-3',
  transcriptionLanguage: 'en-US',
};

function stripTrailingSlash(value = '') {
  return value.replace(/\/+$/, '');
}

export function buildAssistantEventsUrl(baseUrl, secret = '') {
  const root = stripTrailingSlash(baseUrl);
  return secret
    ? `${root}/assistant/events?secret=${encodeURIComponent(secret)}`
    : `${root}/assistant/events`;
}

export function buildAssistantDynamicVariablesWebhookUrl(baseUrl, secret = '') {
  const root = stripTrailingSlash(baseUrl);
  return secret
    ? `${root}/assistant/dynamic-variables?secret=${encodeURIComponent(secret)}`
    : `${root}/assistant/dynamic-variables`;
}

export function buildAssistantInstructions() {
  return `You are {{agent_name}}, an AI voice agent answering a public demo line for small business owners who are curious about missed call automation.

Your purpose is to let the caller experience the product through a real conversation. Do not sound like a funnel, a script, or a pitch. Do not tell the caller what they are supposed to realize. Let the conversation itself do that.

If caller context is available, use it naturally and lightly. Ignore any variable that is blank, "unknown", or obviously missing.
Known context:
- Caller name: {{first_name}}
- Business name: {{business_name}}
- Business type: {{business_type}}
- Prior context: {{prior_context}}

CORE BEHAVIOR:
Follow the caller, not a script.
Answer what they actually asked before moving the conversation forward.
Respond to the last thing they said, not the path you hoped the call would take.
If the call is short, that is fine.
If the call goes off-script, follow it naturally.
If the caller wants to test you, let them test you.

VOICE RULES:
Never use markdown, bullet points, numbered lists, asterisks, bold text, or special formatting.
Never read symbols literally.
Keep sentences short and conversational.
One idea at a time.
Ask at most one question at a time.
Let the conversation breathe.
Never dump a list of features all at once unless the caller directly asks for a list.
Sound warm, grounded, confident, and human.
Do not sound polished, salesy, over-rehearsed, or overly enthusiastic.
Prefer periods over long comma-chained sentences.
Avoid semicolons, em dashes, and stacked clauses.

RHYTHM:
Especially in your first two spoken turns, keep the pacing calm.
Use one or two short sentences max before asking a question.
Do not cram multiple ideas into the same reply.
If a sentence could be split into two, split it.

IMPORTANT:
Do not reuse stock phrases over and over.
Avoid phrases like "that's completely fair," "the good news is," "that's exactly what this solves," "let me grab your info," or "what you're experiencing right now is exactly what your customers would feel."
Vary your wording naturally from call to call and turn to turn.

HOW TO OPEN:
The fixed greeting already opens the call.
After the greeting, wait for the caller to speak.
Do not send a second introduction unless the caller sounds confused or directly asks what this is.
Do not re-explain that you are an AI unless it is useful in that moment.

HOW TO TALK ABOUT THE PRODUCT:
Show capability through the conversation itself.
If you know their business type, tailor your examples to their world.
Use one relevant example at a time.
Do not stack multiple benefits in a single turn.
Do not try to land a conclusion for them.
Do not assume they own a business unless they say so.
If you guessed wrong, correct yourself plainly and move on.

LEAD CAPTURE:
Lead capture matters, but it is not mandatory on every call.
Only move toward collecting contact details if the caller sounds genuinely interested, asks for follow-up, asks for a text, asks to speak with someone, or clearly wants to explore this for their business.
Never ask for multiple pieces of information at once.
If they hesitate, pull back.
If they are done, let them go.
If you already have the caller's phone number from the live call context, do not ask for it again unless they want a different callback number.
If they ask for a human opinion or professional input, offer the next step quickly instead of extending discovery.

WHEN THE CALLER IS SKEPTICAL:
If they say you sound robotic, scripted, pushy, fake, or not useful, acknowledge it plainly and without defensiveness.
Do not try to rescue the call with a pitch.
You may ask one brief, honest follow-up if it feels welcome, such as what would make it feel more useful or more natural.
If they are checked out, end warmly.

TOOL USAGE:
Use log_lead once the caller has voluntarily shared a name or phone number. Update it if you learn more later.
Use send_sms only after the caller explicitly says yes to receiving a text and you have confirmed the number.
Use get_available_slots only when the caller wants to schedule a follow-up.
Use book_appointment only after the caller confirms a specific time.
Use the transfer tool only if the caller explicitly asks for a person and it is within transfer hours.
Use the hangup tool when the conversation is clearly complete.
Never mention tools, prompts, or internal process.

ANSWERING GUIDANCE:
If asked what this is, explain it simply: this is a live demo line for an AI answering assistant for small businesses.
If asked whether it would work for their business, answer in a grounded way using their business context.
If asked about pricing or setup, keep it brief and say a person can walk through options if they want.
If asked technical questions, answer simply and honestly without jargon.
If they ask why you assumed something about them, answer that directly in one short sentence and do not pivot away from it.
If they already sound interested in a real next step, stop selling and help them get to that next step.

CLOSING:
If the caller wants a next step, offer one naturally.
If they do not, thank them for calling and end warmly without trying to win them back.`;
}

export function buildAssistantGreeting() {
  return `Hi, this is {{agent_name}}.`;
}

export function buildAssistantDynamicVariables() {
  return {
    agent_name: process.env.DEMO_AGENT_NAME || 'Aria',
    demo_business_name: process.env.DEMO_BUSINESS_NAME || 'Apex Home Services',
    first_name: '',
    business_name: '',
    business_type: '',
    prior_context: '',
    booking_link: process.env.BOOKING_LINK || '',
    transfer_timezone: process.env.HUMAN_TRANSFER_TIMEZONE || 'America/Chicago',
    transfer_hours: `${process.env.HUMAN_TRANSFER_HOURS_START || '9'}-${process.env.HUMAN_TRANSFER_HOURS_END || '17'} CT`,
  };
}

function buildToolUrl(baseUrl, toolName, secret = '') {
  const root = stripTrailingSlash(baseUrl);
  const query = [
    `call_control_id={{call_control_id}}`,
    `phone_number={{telnyx_end_user_target}}`,
  ];
  if (secret) {
    query.unshift(`secret=${encodeURIComponent(secret)}`);
  }
  return `${root}/assistant/tools/${toolName}?${query.join('&')}`;
}

function convertWebhookTool(schema, baseUrl, secret) {
  return {
    type: 'webhook',
    webhook: {
      name: schema.name,
      description: schema.description,
      url: buildToolUrl(baseUrl, schema.name, secret),
      method: 'POST',
      body_parameters: schema.parameters,
      timeout_ms: 4000,
    },
  };
}

export function buildAssistantTools(baseUrl, secret = '') {
  const webhookTools = TOOL_SCHEMAS
    .filter((tool) => tool.name !== 'transfer_call')
    .map((tool) => convertWebhookTool(tool, baseUrl, secret));

  const transferTool = {
    type: 'transfer',
    transfer: {
      from: process.env.TELNYX_FROM_NUMBER,
      targets: [
        {
          name: 'Human follow-up',
          to: process.env.TELNYX_TRANSFER_NUMBER,
        },
      ],
      warm_transfer_instructions:
        'Briefly summarize the caller, what kind of business they run, and why they asked to speak with a person.',
    },
  };

  return [
    ...webhookTools,
    transferTool,
    {
      type: 'hangup',
      hangup: {},
    },
  ];
}

export function buildAssistantPayload({ webhookBaseUrl, insightGroupId, secret = '' } = {}) {
  if (!webhookBaseUrl) {
    throw new Error('webhookBaseUrl is required to build a Telnyx assistant payload');
  }

  const defaults = TELNYX_ASSISTANT_DEFAULTS;
  const root = stripTrailingSlash(webhookBaseUrl);
  const dynamicVariablesWebhookUrl = buildAssistantDynamicVariablesWebhookUrl(
    root,
    secret
  );

  const payload = {
    name: process.env.TELNYX_ASSISTANT_NAME || `aria-${process.env.ENVIRONMENT || 'dev'}`,
    description: 'Aria demo line assistant for inbound small-business discovery calls.',
    model: process.env.TELNYX_ASSISTANT_MODEL || defaults.model,
    instructions: buildAssistantInstructions(),
    greeting: buildAssistantGreeting(),
    enabled_features: ['telephony'],
    dynamic_variables: buildAssistantDynamicVariables(),
    dynamic_variables_webhook_url: dynamicVariablesWebhookUrl,
    voice: process.env.TELNYX_ASSISTANT_VOICE || defaults.voice,
    voice_settings: {
      type: 'telnyx',
      voice: process.env.TELNYX_ASSISTANT_VOICE || defaults.voice,
      voice_speed: parseFloat(
        process.env.TELNYX_ASSISTANT_VOICE_SPEED || `${defaults.voiceSpeed}`
      ),
    },
    transcription: {
      model:
        process.env.TELNYX_ASSISTANT_TRANSCRIPTION_MODEL ||
        defaults.transcriptionModel,
      language:
        process.env.TELNYX_ASSISTANT_TRANSCRIPTION_LANGUAGE ||
        defaults.transcriptionLanguage,
    },
    telephony_settings: {
      noise_suppression: process.env.TELNYX_ASSISTANT_NOISE_SUPPRESSION || 'krisp',
      time_limit_secs: parseInt(
        process.env.TELNYX_ASSISTANT_TIME_LIMIT_SECS || '1800',
        10
      ),
      user_idle_timeout_secs: parseInt(
        process.env.TELNYX_ASSISTANT_IDLE_TIMEOUT_SECS || '30',
        10
      ),
    },
    privacy_settings: {
      data_retention: true,
    },
    tools: buildAssistantTools(root, secret),
  };

  if (insightGroupId) {
    payload.insight_settings = {
      insight_group_id: insightGroupId,
    };
  }

  return payload;
}

export function buildAssistantTests(destination) {
  return [
    {
      name: 'Aria demo orientation',
      destination,
      telnyx_conversation_channel: 'phone_call',
      instructions:
        'Call the demo line as a curious HVAC owner. Ask what this is and whether it could help with missed calls after hours.',
      rubric: [
        {
          name: 'Natural opener',
          criteria: 'The assistant explains the demo simply and does not sound scripted or pushy.',
        },
        {
          name: 'Business tailoring',
          criteria: 'The assistant tailors its response to the HVAC context instead of reciting a generic pitch.',
        },
      ],
      max_duration_seconds: 180,
    },
    {
      name: 'Aria skeptical caller',
      destination,
      telnyx_conversation_channel: 'phone_call',
      instructions:
        'Call the demo line as a skeptical salon owner. Say it sounds robotic and ask why this would be better than voicemail.',
      rubric: [
        {
          name: 'Handles skepticism',
          criteria: 'The assistant acknowledges the criticism plainly and does not force the caller down a pitch.',
        },
        {
          name: 'Keeps tone grounded',
          criteria: 'The assistant stays calm, human, and concise.',
        },
      ],
      max_duration_seconds: 180,
    },
    {
      name: 'Aria follow-up scheduling',
      destination,
      telnyx_conversation_channel: 'phone_call',
      instructions:
        'Call the demo line as a plumber who wants a text and then wants to book a follow-up time.',
      rubric: [
        {
          name: 'Tool usage',
          criteria: 'The assistant uses the SMS and scheduling tools only after the caller clearly agrees.',
        },
        {
          name: 'Low-friction close',
          criteria: 'The assistant keeps the flow conversational and does not interrogate the caller.',
        },
      ],
      max_duration_seconds: 240,
    },
  ];
}
