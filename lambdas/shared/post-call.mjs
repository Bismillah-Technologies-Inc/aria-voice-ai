import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { query } from './db.mjs';
import { sendSms } from './sms.mjs';

const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || 'us-east-1',
});

export async function summarizeTranscriptWithBedrock(transcript) {
  if (!transcript || transcript.trim().length < 50) {
    return null;
  }

  const prompt = `You are summarizing a sales call transcript for a CRM. Be concise.

Transcript:
${transcript}

Return ONLY a JSON object with these exact keys:
{
  "summary": "2-3 sentence summary",
  "lead_quality": "hot|warm|cold",
  "next_action": "what the follow-up person should do",
  "business_type": "type of business if mentioned",
  "pain_points": ["array", "of", "pain", "points"]
}`;

  const command = new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await bedrock.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return JSON.parse(body.content[0].text);
}

export async function sendPostCallSms(call, lead) {
  if (!call?.phone_number || lead?.sms_sent || call?.post_call_sms_sent) {
    return false;
  }

  const bucket = classifyCallBucket(call, lead);
  if (bucket === 0) {
    return false;
  }

  const message = buildSmsVariant(bucket, lead, call);
  if (!message) {
    return false;
  }

  await sendSms(call.phone_number, message);
  if (call?.id) {
    await query(
      `UPDATE calls
          SET post_call_sms_sent = TRUE
        WHERE id = $1`,
      [call.id]
    );
  }
  if (lead?.id) {
    await query(
      `UPDATE leads
          SET sms_sent = TRUE,
              updated_at = NOW()
        WHERE id = $1`,
      [lead.id]
    );
  }
  return true;
}

function classifyCallBucket(call, lead) {
  if ((call.duration_seconds || 0) < 20) return 0;
  if (call.outcome === 'transferred') return 5;

  const hasName = !!lead?.first_name;
  const hasBusinessType = !!lead?.business_type;
  const hasCallbackTime = !!lead?.callback_time;
  const hasAppointment = !!lead?.appointment_id;

  if (hasName && hasBusinessType && (hasCallbackTime || hasAppointment)) return 4;
  if (hasName && hasBusinessType) return 3;
  if (hasName || hasBusinessType) return 2;
  return 1;
}

function buildSmsVariant(bucket, lead) {
  const name = lead?.first_name || null;
  const bizType = lead?.business_type || 'your business';
  const apptTime = lead?.appointment_label || null;
  const bookLink = process.env.BOOKING_LINK;

  const variants = {
    1: `Hey — you just called the AI demo line. That was Aria. If the timing was bad or you got cut off, just call back whenever. Or reply here and I'll answer any questions personally. — Mirza`,
    2: name
      ? `Hey ${name}! You just called the AI demo line — hope Aria made a decent first impression. I'm Mirza. If you want to see what this would look like set up for your business, just reply and we'll find a time. No pressure.`
      : `Hey! You were just talking to Aria about ${bizType} — I'm Mirza, I build these. Just reply with your name and I'll personally walk you through what this would look like for your operation.`,
    3: `Hey ${name} — Aria grabbed your info but we didn't get a time on the calendar. I'd love to show you what this looks like set up for ${bizType}. Just reply with a day and time that works. — Mirza`,
    4: apptTime
      ? `Hey ${name} — you're all set! Your call with Mirza is confirmed for ${apptTime}. Reply here if anything comes up. See you then. — Aria`
      : `Hey ${name} — great talking through this. Someone will reach out within one business day to walk you through exactly what this would look like for ${bizType}. — Aria`,
    5: `Hey ${name || 'there'} — looks like we got cut off during the transfer. Mirza here — just reply and I'll call you right back, or grab a time here: ${bookLink}`,
  };

  return variants[bucket] || null;
}
