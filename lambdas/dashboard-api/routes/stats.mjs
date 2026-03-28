/**
 * /api/stats route — aggregated KPIs for the dashboard home page.
 */

import { query } from '../../shared/db.mjs';

export async function handleStats(method, path, event) {
  if (method !== 'GET') {
    return { statusCode: 405, body: { error: 'Method not allowed' } };
  }

  const params = event.queryStringParameters || {};
  const days = Math.min(parseInt(params.days || '30', 10), 365);

  // Run all queries in parallel
  const [totalCalls, totalLeads, outcomes, avgDuration, dailyVolume, recentLeads] =
    await Promise.all([
      query(
        `SELECT COUNT(*) FROM calls WHERE started_at >= NOW() - $1::int * INTERVAL '1 day'`,
        [days],
      ),
      query(
        `SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'`,
        [days],
      ),
      query(
        `SELECT outcome, COUNT(*)
         FROM calls WHERE started_at >= NOW() - $1::int * INTERVAL '1 day'
         GROUP BY outcome`,
        [days],
      ),
      query(
        `SELECT AVG(duration_seconds)::int as avg_duration
         FROM calls
         WHERE started_at >= NOW() - $1::int * INTERVAL '1 day'
           AND duration_seconds > 0`,
        [days],
      ),
      query(
        `SELECT DATE(started_at) as day, COUNT(*)::int as count
         FROM calls
         WHERE started_at >= NOW() - $1::int * INTERVAL '1 day'
         GROUP BY DATE(started_at)
         ORDER BY day`,
        [days],
      ),
      query(
        `SELECT id, first_name, business_name, phone_number, created_at
         FROM leads
         ORDER BY created_at DESC
         LIMIT 5`,
      ),
    ]);

  const outcomeMap = {};
  for (const row of outcomes.rows) {
    outcomeMap[row.outcome] = parseInt(row.count, 10);
  }

  const callCount = parseInt(totalCalls.rows[0].count, 10);
  const leadsCaptured = outcomeMap['lead_captured'] || 0;

  return {
    body: {
      period_days: days,
      total_calls: callCount,
      total_leads: parseInt(totalLeads.rows[0].count, 10),
      leads_captured: leadsCaptured,
      calls_transferred: outcomeMap['transferred'] || 0,
      calls_abandoned: outcomeMap['abandoned'] || 0,
      conversion_rate: callCount > 0
        ? parseFloat(((leadsCaptured / callCount) * 100).toFixed(1))
        : 0,
      avg_call_duration: avgDuration.rows[0]?.avg_duration || 0,
      daily_volume: dailyVolume.rows,
      recent_leads: recentLeads.rows,
    },
  };
}
