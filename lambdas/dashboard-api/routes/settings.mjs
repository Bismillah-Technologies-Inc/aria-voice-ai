/**
 * /api/settings routes — read and update agent configuration.
 */

import { query } from '../../shared/db.mjs';

const ALLOWED_FIELDS = [
  'business_name',
  'agent_name',
  'greeting_style',
  'transfer_hours_start',
  'transfer_hours_end',
  'transfer_timezone',
  'booking_link',
  'sms_enabled',
  'auto_summary',
  'custom_prompt',
];

export async function handleSettings(method, path, event) {
  // GET /api/settings
  if (method === 'GET') {
    const res = await query('SELECT * FROM settings ORDER BY created_at LIMIT 1');
    if (!res.rows.length) {
      return { statusCode: 404, body: { error: 'No settings found' } };
    }
    return { body: res.rows[0] };
  }

  // PUT /api/settings
  if (method === 'PUT') {
    const body = JSON.parse(event.body || '{}');

    // Build dynamic UPDATE from allowed fields only
    const updates = [];
    const values = [];
    let idx = 1;

    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        values.push(body[field]);
      }
    }

    if (!updates.length) {
      return { statusCode: 400, body: { error: 'No valid fields to update' } };
    }

    updates.push('updated_at = NOW()');

    // Get the settings row ID
    const existing = await query('SELECT id FROM settings ORDER BY created_at LIMIT 1');
    if (!existing.rows.length) {
      return { statusCode: 404, body: { error: 'No settings found' } };
    }

    const settingsId = existing.rows[0].id;
    values.push(settingsId);

    await query(
      `UPDATE settings SET ${updates.join(', ')} WHERE id = $${idx}`,
      values,
    );

    const updated = await query('SELECT * FROM settings WHERE id = $1', [settingsId]);
    return { body: updated.rows[0] };
  }

  return { statusCode: 405, body: { error: 'Method not allowed' } };
}
