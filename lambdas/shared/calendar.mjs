import { google } from 'googleapis';

function getAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

/**
 * Get available 30-minute slots for the next 5 business days.
 * Returns array of { start: ISO string, end: ISO string, label: "Mon Mar 10 at 2:00 PM" }
 */
export async function getAvailableSlots() {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const fiveDaysOut = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

  const busyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: fiveDaysOut.toISOString(),
      timeZone: 'America/Chicago',
      items: [{ id: process.env.GOOGLE_CALENDAR_ID }],
    },
  });

  const busy = busyRes.data.calendars[process.env.GOOGLE_CALENDAR_ID].busy || [];

  // Generate 9am–5pm slots in 30-min increments for next 5 days
  const slots = [];
  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);
  if (cursor.getHours() >= 17) {
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(9);
  } else if (cursor.getHours() < 9) {
    cursor.setHours(9);
  }

  while (cursor < fiveDaysOut && slots.length < 6) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) { // skip weekends
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      const overlaps = busy.some(b =>
        new Date(b.start) < slotEnd && new Date(b.end) > cursor
      );
      if (!overlaps && cursor.getHours() >= 9 && cursor.getHours() < 17) {
        slots.push({
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
          label: cursor.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
          }),
        });
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 30);
    if (cursor.getHours() >= 17) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(9);
      cursor.setMinutes(0);
    }
  }

  return slots;
}

/**
 * Book a specific slot.
 * @param {string} startIso - ISO start time
 * @param {string} endIso - ISO end time
 * @param {string} attendeeName
 * @param {string} attendeePhone
 * @param {string} businessName
 * @returns {string} Google Calendar event ID
 */
export async function bookSlot(startIso, endIso, attendeeName, attendeePhone, businessName) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary:     `Follow-up: ${attendeeName} — ${businessName}`,
      description: `Lead captured via Aria demo line.\nPhone: ${attendeePhone}\nBusiness: ${businessName}`,
      start: { dateTime: startIso, timeZone: 'America/Chicago' },
      end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
    },
  });

  return event.data.id;
}
