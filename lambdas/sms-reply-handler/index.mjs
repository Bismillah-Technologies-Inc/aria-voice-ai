import { query } from '../shared/db.mjs';
import { sendSms } from '../shared/sms.mjs';

export const handler = async (event) => {
  const snsMessage  = JSON.parse(event.Records[0].Sns.Message);
  const fromNumber  = snsMessage.originationNumber;
  const replyText   = snsMessage.messageBody?.trim() || '';

  console.log(`[SMS REPLY] From: ${fromNumber}, Body: "${replyText}"`);

  // Look up lead by phone number
  const leadRes = await query(
    `SELECT * FROM leads WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
    [fromNumber]
  );

  if (!leadRes.rows.length) {
    // Unknown number — open a new conversation
    await sendSms(fromNumber,
      `Hey! Mirza here. I don't have your info on file yet — ` +
      `what's your name and what kind of business do you run? I'll reach out personally.`
    );
    return;
  }

  const lead = leadRes.rows[0];

  // Detect if reply looks like a name (short, no URL, under 40 chars)
  const looksLikeName = replyText.split(' ').length <= 3 &&
                        !replyText.includes('http') &&
                        replyText.length < 40 &&
                        replyText.length > 1;

  if (looksLikeName && !lead.first_name) {
    // Capture the name they just texted, send booking link
    await query(
      `UPDATE leads SET first_name = $1, updated_at = NOW() WHERE id = $2`,
      [replyText, lead.id]
    );
    await sendSms(fromNumber,
      `Got it, ${replyText}! I'll reach out within one business day. ` +
      `Or if you want to grab a time now: ${process.env.BOOKING_LINK}`
    );
    console.log(`[SMS REPLY] Name captured: ${replyText} for lead ${lead.id}`);
    return;
  }

  // Everything else — forward to Mirza immediately + send acknowledgement
  await Promise.all([
    sendSms(process.env.MIRZA_PHONE,
      `[ARIA LEAD REPLY]\n` +
      `From: ${fromNumber}\n` +
      `Lead: ${lead.first_name || 'unknown'} — ${lead.business_type || 'unknown biz'}\n` +
      `Message: "${replyText}"`
    ),
    sendSms(fromNumber,
      `Got it — Mirza will follow up with you shortly.`
    ),
  ]);

  console.log(`[SMS REPLY] Forwarded to Mirza from ${fromNumber}`);
};
