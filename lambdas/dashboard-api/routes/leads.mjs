/**
 * /api/leads routes — lead list with pagination and detail view.
 */

import { query } from '../../shared/db.mjs';

export async function handleLeads(method, path, event) {
  // GET /api/leads/:id — single lead with associated calls
  const idMatch = path.match(/^\/api\/leads\/([a-f0-9-]+)$/);
  if (idMatch && method === 'GET') {
    const leadRes = await query('SELECT * FROM leads WHERE id = $1', [idMatch[1]]);
    if (!leadRes.rows.length) return { statusCode: 404, body: { error: 'Lead not found' } };

    const callsRes = await query(
      `SELECT id, started_at, duration_seconds, outcome, summary
       FROM calls WHERE lead_id = $1 ORDER BY started_at DESC`,
      [idMatch[1]],
    );

    return { body: { ...leadRes.rows[0], calls: callsRes.rows } };
  }

  // GET /api/leads — paginated list
  if (method === 'GET') {
    const params = event.queryStringParameters || {};
    const page = parseInt(params.page || '1', 10);
    const limit = Math.min(parseInt(params.limit || '20', 10), 100);
    const offset = (page - 1) * limit;

    const where = [];
    const values = [];
    let idx = 1;

    if (params.business_type) {
      where.push(`l.business_type = $${idx++}`);
      values.push(params.business_type);
    }
    if (params.search) {
      where.push(`(l.first_name ILIKE $${idx} OR l.business_name ILIKE $${idx} OR l.phone_number ILIKE $${idx})`);
      values.push(`%${params.search}%`);
      idx++;
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await query(
      `SELECT COUNT(*) FROM leads l ${whereClause}`,
      values,
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataValues = [...values, limit, offset];
    const res = await query(
      `SELECT l.*, COUNT(c.id)::int as call_count
       FROM leads l LEFT JOIN calls c ON c.lead_id = l.id
       ${whereClause}
       GROUP BY l.id
       ORDER BY l.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      dataValues,
    );

    return { body: { leads: res.rows, total, page, limit } };
  }

  return { statusCode: 405, body: { error: 'Method not allowed' } };
}
