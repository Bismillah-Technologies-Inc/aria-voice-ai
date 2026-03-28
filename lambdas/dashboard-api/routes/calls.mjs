/**
 * /api/calls routes — call log with pagination, filters, and detail view.
 */

import { query } from '../../shared/db.mjs';

export async function handleCalls(method, path, event) {
  // GET /api/calls/:id — single call detail
  const idMatch = path.match(/^\/api\/calls\/([a-f0-9-]+)$/);
  if (idMatch && method === 'GET') {
    const res = await query(
      `SELECT c.*, l.first_name, l.business_name, l.business_type
       FROM calls c LEFT JOIN leads l ON c.lead_id = l.id
       WHERE c.id = $1`,
      [idMatch[1]],
    );
    if (!res.rows.length) return { statusCode: 404, body: { error: 'Call not found' } };
    return { body: res.rows[0] };
  }

  // GET /api/calls — paginated list with filters
  if (method === 'GET') {
    const params = event.queryStringParameters || {};
    const page = parseInt(params.page || '1', 10);
    const limit = Math.min(parseInt(params.limit || '20', 10), 100);
    const offset = (page - 1) * limit;

    const where = [];
    const values = [];
    let idx = 1;

    if (params.outcome) {
      where.push(`c.outcome = $${idx++}`);
      values.push(params.outcome);
    }
    if (params.from) {
      where.push(`c.started_at >= $${idx++}`);
      values.push(params.from);
    }
    if (params.to) {
      where.push(`c.started_at <= $${idx++}`);
      values.push(params.to);
    }
    if (params.phone) {
      where.push(`c.phone_number = $${idx++}`);
      values.push(params.phone);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await query(
      `SELECT COUNT(*) FROM calls c ${whereClause}`,
      values,
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataValues = [...values, limit, offset];
    const res = await query(
      `SELECT c.id, c.contact_id, c.phone_number, c.duration_seconds,
              c.outcome, c.started_at, c.ended_at, c.tools_used,
              l.first_name, l.business_name
       FROM calls c LEFT JOIN leads l ON c.lead_id = l.id
       ${whereClause}
       ORDER BY c.started_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      dataValues,
    );

    return { body: { calls: res.rows, total, page, limit } };
  }

  return { statusCode: 405, body: { error: 'Method not allowed' } };
}
