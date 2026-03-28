#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { loadEnvFile, requireEnv } from './_env.mjs';

const environment = process.argv[2] || 'dev';
loadEnvFile(environment);

requireEnv(['TELNYX_API_KEY', 'TELNYX_ASSISTANT_ID']);

const minutesBack = Number.parseInt(process.argv[3] || '30', 10);
const region = process.env.AWS_REGION || 'us-east-1';
const functionName =
  process.env.TELNYX_ASSISTANT_WEBHOOK_FUNCTION_NAME ||
  `aria-${environment}-assistant-webhooks`;
const logGroupName = `/aws/lambda/${functionName}`;

async function telnyxRequest(path) {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Telnyx API GET ${path} failed (${response.status}): ${text}`);
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

async function fetchConversationMessages(conversationId) {
  return listAll(`/ai/conversations/${conversationId}/messages`);
}

function filterRecentAssistantConversations(conversations) {
  const cutoff = Date.now() - minutesBack * 60 * 1000;

  return conversations
    .filter((conversation) => {
      const metadata = conversation.metadata || {};
      const createdAt = new Date(
        conversation.created_at ||
          conversation.last_message_at ||
          conversation.updated_at ||
          0
      ).getTime();

      return (
        createdAt >= cutoff &&
        metadata.assistant_id === process.env.TELNYX_ASSISTANT_ID &&
        metadata.telnyx_conversation_channel === 'phone_call'
      );
    })
    .sort((left, right) => {
      const leftTime = new Date(
        left.last_message_at || left.created_at || left.updated_at || 0
      ).getTime();
      const rightTime = new Date(
        right.last_message_at || right.created_at || right.updated_at || 0
      ).getTime();
      return rightTime - leftTime;
    });
}

function fetchRecentEventLogs(conversationId) {
  const startTime = `${Date.now() - minutesBack * 60 * 1000}`;
  const filterPattern = conversationId
    ? `"${conversationId}" "[ASSISTANT EVENTS] handled"`
    : `"[ASSISTANT EVENTS] handled"`;

  const raw = execFileSync(
    'aws',
    [
      'logs',
      'filter-log-events',
      '--log-group-name',
      logGroupName,
      '--start-time',
      startTime,
      '--filter-pattern',
      filterPattern,
      '--region',
      region,
      '--output',
      'json',
      '--no-cli-pager',
    ],
    {
      encoding: 'utf8',
    }
  );

  return JSON.parse(raw).events || [];
}

async function main() {
  const conversations = await listAll('/ai/conversations');
  const recentConversations = filterRecentAssistantConversations(conversations);

  if (!recentConversations.length) {
    throw new Error(
      `No assistant phone_call conversations found in the last ${minutesBack} minutes.`
    );
  }

  const latestConversation = recentConversations[0];
  const messages = await fetchConversationMessages(latestConversation.id);
  if (!messages.length) {
    throw new Error(
      `Conversation ${latestConversation.id} exists but has no messages yet.`
    );
  }

  const logs = fetchRecentEventLogs(latestConversation.id);
  if (!logs.length) {
    throw new Error(
      `Conversation ${latestConversation.id} has messages, but no recent assistant event logs were found in ${logGroupName}.`
    );
  }

  console.log(`Assistant cutover verification passed for ${environment}`);
  console.log(`Conversation ID: ${latestConversation.id}`);
  console.log(`Messages: ${messages.length}`);
  console.log(`Lambda event logs: ${logs.length}`);
  console.log(
    `Latest event log timestamp: ${new Date(logs[logs.length - 1].timestamp).toISOString()}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
