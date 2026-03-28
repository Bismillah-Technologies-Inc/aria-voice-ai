/**
 * Dashboard API — Lambda-native HTTP router for the Aria dashboard.
 * Handles API Gateway v2 (HTTP API) events with Cognito JWT authorization.
 */

import { handleCalls } from './routes/calls.mjs';
import { handleLeads } from './routes/leads.mjs';
import { handleStats } from './routes/stats.mjs';
import { handleSettings } from './routes/settings.mjs';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
};

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  // Strip stage prefix: /dev/api/stats → /api/stats
  const path = (event.rawPath || '').replace(/^\/[^/]+(?=\/api\/)/, '');

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    let result;

    if (path.startsWith('/api/stats')) {
      result = await handleStats(method, path, event);
    } else if (path.startsWith('/api/calls')) {
      result = await handleCalls(method, path, event);
    } else if (path.startsWith('/api/leads')) {
      result = await handleLeads(method, path, event);
    } else if (path.startsWith('/api/settings')) {
      result = await handleSettings(method, path, event);
    } else {
      result = { statusCode: 404, body: { error: 'Not found' } };
    }

    return {
      statusCode: result.statusCode || 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error('[DASHBOARD-API ERROR]', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
