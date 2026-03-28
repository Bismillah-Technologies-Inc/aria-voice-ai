#!/usr/bin/env node
import { loadEnvFile, requireEnv, upsertEnvFile } from './_env.mjs';

const environment = process.argv[2] || 'dev';
const target = process.argv[3] || 'shadow';
const envFile = loadEnvFile(environment);

requireEnv(['TELNYX_API_KEY', 'TELNYX_ASSISTANT_ID']);

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

async function main() {
  const phoneNumber =
    process.argv[4] ||
    (target === 'primary'
      ? process.env.TELNYX_FROM_NUMBER
      : process.env.TELNYX_SHADOW_NUMBER);

  if (!phoneNumber) {
    throw new Error(`No phone number configured for target "${target}".`);
  }

  const assistantResponse = await telnyxRequest(
    `/ai/assistants/${process.env.TELNYX_ASSISTANT_ID}`
  );
  const assistant = assistantResponse.data || assistantResponse;
  const connectionId =
    assistant.telephony_settings?.default_texml_app_id ||
    assistant.default_texml_app_id ||
    process.env.TELNYX_ASSISTANT_TEXML_APP_ID;

  if (!connectionId) {
    throw new Error('Assistant default TeXML app ID was not present in the assistant response.');
  }

  const response = await telnyxRequest('/phone_numbers/jobs/update_phone_numbers', {
    method: 'POST',
    body: {
      phone_numbers: [phoneNumber],
      connection_id: connectionId,
    },
  });

  upsertEnvFile(envFile, {
    TELNYX_ASSISTANT_TEXML_APP_ID: connectionId,
  });

  console.log(`Assigned ${phoneNumber} to assistant ${process.env.TELNYX_ASSISTANT_ID}`);
  console.log(`Connection ID: ${connectionId}`);
  console.log(`Job status: ${response.data?.status || response.status || 'submitted'}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
