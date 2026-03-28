/**
 * Send an SMS via Telnyx.
 * Uses native fetch (Node 20) — no SDK needed.
 * @param {string} to - E.164 phone number
 * @param {string} text - Message body
 */
export async function sendSms(to, text) {
  const resp = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from: process.env.TELNYX_FROM_NUMBER,
      to,
      text,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telnyx SMS failed: ${resp.status} ${body}`);
  }
  return resp.json();
}
