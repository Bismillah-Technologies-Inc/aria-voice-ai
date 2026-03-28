#!/usr/bin/env node
import { loadEnvFile, requireEnv } from './_env.mjs';

const environment = process.argv[2] || 'dev';
const target = process.argv[3] || 'primary';
loadEnvFile(environment);

requireEnv(['TELNYX_API_KEY', 'TELNYX_APP_ID']);

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
    (target === 'shadow'
      ? process.env.TELNYX_SHADOW_NUMBER
      : process.env.TELNYX_FROM_NUMBER);

  if (!phoneNumber) {
    throw new Error(`No phone number configured for rollback target "${target}".`);
  }

  const response = await telnyxRequest('/phone_numbers/jobs/update_phone_numbers', {
    method: 'POST',
    body: {
      phone_numbers: [phoneNumber],
      connection_id: process.env.TELNYX_APP_ID,
    },
  });

  console.log(`Rolled ${phoneNumber} back to Call Control application ${process.env.TELNYX_APP_ID}`);
  console.log(`Job status: ${response.data?.status || response.status || 'submitted'}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
