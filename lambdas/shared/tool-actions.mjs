import { query } from './db.mjs';
import { sendSms } from './sms.mjs';
import { getAvailableSlots, bookSlot } from './calendar.mjs';

function resolvePhoneNumber(args, context) {
  return args?.phone_number || context?.phoneNumber || null;
}

function getCallLookupClause(context = {}) {
  const values = [];
  const clauses = [];

  if (context.conversationId) {
    values.push(context.conversationId);
    clauses.push(`conversation_id = $${values.length}`);
  }
  if (context.callControlId) {
    values.push(context.callControlId);
    clauses.push(`contact_id = $${values.length}`);
  }
  if (context.phoneNumber) {
    values.push(context.phoneNumber);
    clauses.push(`phone_number = $${values.length}`);
  }

  return { clauses, values };
}

async function linkLeadToCall(leadId, context = {}) {
  const { clauses, values } = getCallLookupClause(context);
  if (!clauses.length) {
    return;
  }

  values.push(leadId);
  await query(
    `UPDATE calls
       SET lead_id = $${values.length}
     WHERE id = (
       SELECT id
       FROM calls
       WHERE ${clauses.join(' OR ')}
       ORDER BY started_at DESC
       LIMIT 1
     )`,
    values
  );
}

async function updateCallOutcome(outcome, context = {}) {
  const { clauses, values } = getCallLookupClause(context);
  if (!clauses.length) {
    return;
  }

  values.push(outcome);
  await query(
    `UPDATE calls
       SET outcome = $${values.length}
     WHERE id = (
       SELECT id
       FROM calls
       WHERE ${clauses.join(' OR ')}
       ORDER BY started_at DESC
       LIMIT 1
     )`,
    values
  );
}

async function markLeadTransferred(phoneNumber) {
  if (!phoneNumber) {
    return;
  }

  await query(
    `UPDATE leads
       SET transferred = TRUE,
           updated_at = NOW()
     WHERE phone_number = $1`,
    [phoneNumber]
  );
}

export function isHumanTransferAvailable(now = new Date()) {
  const timezone = process.env.HUMAN_TRANSFER_TIMEZONE || 'America/Chicago';
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const hour = localNow.getHours();
  const day = localNow.getDay();
  const start = parseInt(process.env.HUMAN_TRANSFER_HOURS_START || '9', 10);
  const end = parseInt(process.env.HUMAN_TRANSFER_HOURS_END || '17', 10);

  return day !== 0 && day !== 6 && hour >= start && hour < end;
}

export async function sendSmsAction(args = {}, context = {}) {
  const phoneNumber = resolvePhoneNumber(args, context);
  if (!phoneNumber) {
    throw new Error('phone_number is required to send an SMS');
  }

  const link =
    args.message_type === 'info_link'
      ? process.env.INFO_LINK || process.env.BOOKING_LINK
      : process.env.BOOKING_LINK;
  const text =
    args.message_type === 'info_link'
      ? `Hi! Here's the info Aria mentioned: ${link}\n\nReply STOP to opt out.`
      : `Hi! Here's the booking link Aria mentioned: ${link}\n\nReply STOP to opt out.`;

  await sendSms(phoneNumber, text);
  await query(
    `UPDATE leads
       SET sms_sent = TRUE,
           updated_at = NOW()
     WHERE phone_number = $1`,
    [phoneNumber]
  );

  return {
    success: true,
    message: 'SMS sent successfully',
    phone_number: phoneNumber,
  };
}

export async function logLeadAction(args = {}, context = {}) {
  const phoneNumber = resolvePhoneNumber(args, context);
  if (!phoneNumber) {
    throw new Error('phone_number is required to log a lead');
  }

  const firstName = args.first_name || null;
  const businessName = args.business_name || null;
  const businessType = args.business_type || null;
  const callbackDay = args.callback_day || null;
  const callbackTime = args.callback_time || null;

  const existing = await query(
    `SELECT id
       FROM leads
      WHERE phone_number = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [phoneNumber]
  );

  let leadId;
  let action;

  if (existing.rows.length > 0) {
    leadId = existing.rows[0].id;
    action = 'updated';
    await query(
      `UPDATE leads
          SET first_name = COALESCE($2, first_name),
              business_name = COALESCE($3, business_name),
              business_type = COALESCE($4, business_type),
              callback_day = COALESCE($5, callback_day),
              callback_time = COALESCE($6, callback_time),
              updated_at = NOW()
        WHERE id = $1`,
      [leadId, firstName, businessName, businessType, callbackDay, callbackTime]
    );
  } else {
    action = 'created';
    const inserted = await query(
      `INSERT INTO leads (
         phone_number,
         first_name,
         business_name,
         business_type,
         callback_day,
         callback_time
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [phoneNumber, firstName, businessName, businessType, callbackDay, callbackTime]
    );
    leadId = inserted.rows[0].id;
  }

  await linkLeadToCall(leadId, { ...context, phoneNumber });

  return {
    success: true,
    action,
    lead_id: leadId,
    phone_number: phoneNumber,
  };
}

export async function getAvailableSlotsAction() {
  const slots = await getAvailableSlots();
  if (!slots.length) {
    return {
      success: true,
      slots: [],
      message: 'No availability in the next 5 business days.',
    };
  }

  return {
    success: true,
    slots,
  };
}

export async function bookAppointmentAction(args = {}, context = {}) {
  const phoneNumber = resolvePhoneNumber(args, context);
  if (!phoneNumber) {
    throw new Error('phone_number is required to book an appointment');
  }

  const attendeeName = args.attendee_name || args.first_name || 'Caller';
  const businessName = args.business_name || context.businessName || '';
  const eventId = await bookSlot(
    args.start_iso,
    args.end_iso,
    attendeeName,
    phoneNumber,
    businessName
  );

  await query(
    `UPDATE leads
        SET appointment_id = $1,
            updated_at = NOW()
      WHERE phone_number = $2`,
    [eventId, phoneNumber]
  );
  await updateCallOutcome('appointment_booked', { ...context, phoneNumber });

  return {
    success: true,
    event_id: eventId,
    message: 'Appointment booked successfully.',
  };
}

export async function transferCallAction(args = {}, context = {}) {
  const callControlId = args.call_control_id || context.callControlId || null;
  const phoneNumber = resolvePhoneNumber(args, context);

  if (!callControlId) {
    throw new Error('call_control_id is required to transfer a call');
  }

  if (!isHumanTransferAvailable()) {
    return {
      success: false,
      available: false,
      message: 'Outside business hours. Offer to schedule a callback instead.',
    };
  }

  const response = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: process.env.TELNYX_TRANSFER_NUMBER,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telnyx transfer failed: ${response.status} ${body}`);
  }

  await updateCallOutcome('transferred', { ...context, phoneNumber });
  await markLeadTransferred(phoneNumber);

  return {
    success: true,
    message: 'Transferring now.',
  };
}

export async function executeBusinessTool(toolName, args = {}, context = {}) {
  switch (toolName) {
    case 'send_sms':
      return sendSmsAction(args, context);
    case 'log_lead':
      return logLeadAction(args, context);
    case 'get_available_slots':
      return getAvailableSlotsAction(args, context);
    case 'book_appointment':
      return bookAppointmentAction(args, context);
    case 'transfer_call':
      return transferCallAction(args, context);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export function stringifyToolResult(result) {
  return JSON.stringify(result);
}
