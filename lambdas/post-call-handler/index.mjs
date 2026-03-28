import { query } from '../shared/db.mjs';
import {
  sendPostCallSms,
  summarizeTranscriptWithBedrock,
} from '../shared/post-call.mjs';

export const handler = async (event) => {
  console.log('[POST-CALL EVENT]', JSON.stringify(event));

  // Invoked from EC2 bridge via Function URL (Telnyx flow)
  // Body: { contactId: <calls.id>, callerPhone: "+1..." }
  if (!event.requestContext?.http) return;
  let contactId;
  try {
    const body = JSON.parse(event.body || '{}');
    contactId  = body.contactId;
  } catch {}
  if (!contactId) return;

  const callRes = await query(
    `SELECT * FROM calls WHERE contact_id = $1 LIMIT 1`,
    [contactId]
  );
  if (!callRes.rows.length) return;

  const call = callRes.rows[0];

  // Fetch lead record
  let lead = null;
  if (call.lead_id) {
    const leadRes = await query(`SELECT * FROM leads WHERE id = $1`, [call.lead_id]);
    if (leadRes.rows.length) lead = leadRes.rows[0];
  }
  if (!lead && call.phone_number) {
    const leadRes = await query(
      `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [call.phone_number]
    );
    if (leadRes.rows.length) lead = leadRes.rows[0];
  }

  // ── 1. POST-CALL SMS (fires immediately) ──────────────────────
  await sendPostCallSms(call, lead);

  // ── 2. BEDROCK SUMMARY (runs after SMS) ───────────────────────
  if (!call.transcript || call.transcript.trim().length < 50) return;

  try {
    const parsed = await summarizeTranscriptWithBedrock(call.transcript);
    if (!parsed) return;

    await query(`UPDATE calls SET summary = $1 WHERE id = $2`, [JSON.stringify(parsed), call.id]);

    if (parsed.business_type && call.lead_id) {
      await query(
        `UPDATE leads SET business_type = COALESCE(business_type, $1), updated_at = NOW() WHERE id = $2`,
        [parsed.business_type, call.lead_id]
      );
    }
  } catch (err) {
    console.error('[POST-CALL SUMMARY ERROR]', err);
  }
};
