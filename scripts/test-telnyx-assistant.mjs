#!/usr/bin/env node
import { buildAssistantTests } from '../lambdas/shared/telnyx-assistant.mjs';
import { loadEnvFile, requireEnv } from './_env.mjs';

const environment = process.argv[2] || 'dev';
loadEnvFile(environment);

requireEnv(['TELNYX_API_KEY']);

const destination =
  process.argv[3] ||
  process.env.TELNYX_SHADOW_NUMBER ||
  process.env.TELNYX_FROM_NUMBER;

if (!destination) {
  throw new Error('Provide a destination number or set TELNYX_SHADOW_NUMBER.');
}

const suiteName = `aria-${environment}`;

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
    const detail = data.errors?.[0]?.detail || '';
    if (
      response.status === 422 &&
      detail.includes('Model meta-llama/Meta-Llama-3.1-70B-Instruct is not available for AI Assistants.')
    ) {
      throw new Error(
        'Telnyx Assistant Tests is rejecting phone-call test creation with a platform-side model error. The payload shape is now correct, but the managed tests API currently needs Telnyx-side resolution. Use `npm run assistant:verify:dev` after a manual inbound call as the rollout verification path for now.'
      );
    }
    throw new Error(`Telnyx API ${method} ${path} failed (${response.status}): ${text}`);
  }
  return data;
}

async function listSuiteTests() {
  const response = await telnyxRequest(
    `/ai/assistants/tests?test_suite=${encodeURIComponent(
      suiteName
    )}&telnyx_conversation_channel=phone_call`
  );
  return response.data || [];
}

async function main() {
  const existingByName = new Map(
    (await listSuiteTests()).map((test) => [test.name, test])
  );

  const tests = buildAssistantTests(destination).map((test) => ({
    ...test,
    test_suite: suiteName,
  }));

  const persisted = [];

  for (const test of tests) {
    const existing = existingByName.get(test.name);
    const response = existing
      ? await telnyxRequest(`/ai/assistants/tests/${existing.test_id}`, {
          method: 'PUT',
          body: test,
        })
      : await telnyxRequest('/ai/assistants/tests', {
          method: 'POST',
          body: test,
        });

    persisted.push(response.data || response);
  }

  const runResponse = await telnyxRequest(
    `/ai/assistants/tests/test-suites/${encodeURIComponent(suiteName)}/runs`,
    {
      method: 'POST',
    }
  );
  const runs = Array.isArray(runResponse) ? runResponse : runResponse.data || [];

  console.log(`Assistant tests ready for ${environment}`);
  for (const test of persisted) {
    console.log(`- ${test.name}: ${test.test_id}`);
  }
  console.log('Triggered suite run:');
  for (const run of runs) {
    console.log(`- test ${run.test_id}: ${run.status} (run ${run.run_id})`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
