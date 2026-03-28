import { executeBusinessTool, stringifyToolResult } from './tool-actions.mjs';

// ─────────────────────────────────────────────────────────────
// TOOL SCHEMAS
// These are sent to Deepgram in the initial Voice Agent config.
// Deepgram passes them to the LLM as available functions.
// ─────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    name: 'send_sms',
    description: 'Send an SMS to the caller right now. Use this when the caller agrees to receive a booking or info link. Always confirm their number before calling this.',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Caller phone number in E.164 format, e.g. +17085551234'
        },
        message_type: {
          type: 'string',
          enum: ['booking_link', 'info_link'],
          description: 'booking_link sends the Cal.com booking URL. info_link sends a general info page.'
        }
      },
      required: ['phone_number', 'message_type']
    }
  },
  {
    name: 'log_lead',
    description: 'Save the caller\'s information to the CRM database. Call this as soon as you have collected first_name AND either business_name or phone_number. Update it again when you collect more fields.',
    parameters: {
      type: 'object',
      properties: {
        phone_number:  { type: 'string', description: 'E.164 format' },
        first_name:    { type: 'string' },
        business_name: { type: 'string' },
        business_type: { type: 'string', description: 'e.g. HVAC, plumbing, dental, salon' },
        callback_day:  { type: 'string', description: 'e.g. Monday, Tuesday' },
        callback_time: { type: 'string', description: 'e.g. 2pm, morning, anytime' }
      },
      required: ['phone_number']
    }
  },
  {
    name: 'get_available_slots',
    description: 'Get the next available calendar slots for scheduling a follow-up call. Call this when the caller is ready to book a specific time. Returns up to 6 options.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a specific calendar slot for the follow-up call. Only call this after the caller has confirmed a specific slot from get_available_slots.',
    parameters: {
      type: 'object',
      properties: {
        start_iso:     { type: 'string', description: 'ISO 8601 start time from get_available_slots' },
        end_iso:       { type: 'string', description: 'ISO 8601 end time from get_available_slots' },
        attendee_name: { type: 'string' },
        phone_number:  { type: 'string' },
        business_name: { type: 'string' }
      },
      required: ['start_iso', 'end_iso', 'attendee_name', 'phone_number']
    }
  },
  {
    name: 'transfer_call',
    description: 'Transfer this call to a human. Only offer this if the caller explicitly asks to speak to a person. Check business hours first — only transfer Mon-Fri 9am-5pm CT.',
    parameters: {
      type: 'object',
      properties: {
        call_control_id: {
          type: 'string',
          description: 'The Telnyx call_control_id for this call'
        },
        reason: {
          type: 'string',
          description: 'Why the caller wants to speak to a human, e.g. pricing, technical questions'
        }
      },
      required: ['call_control_id']
    }
  }
];

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────────────────

/**
 * Execute a tool call from Deepgram.
 * @param {string} toolName
 * @param {object} args - Parsed JSON arguments from LLM
 * @returns {string} - Result string to send back to Deepgram as function result
 */
export async function executeTool(toolName, args) {
  console.log('[TOOL]', toolName, JSON.stringify(args));

  try {
    const result = await executeBusinessTool(toolName, args);
    return stringifyToolResult(result);
  } catch (err) {
    console.error('[TOOL ERROR]', toolName, err);
    return JSON.stringify({ success: false, error: err.message });
  }
}
