// ─── API response types ────────────────────────────────────────────────────

export interface Call {
  id: string;
  contact_id: string;
  phone_number: string;
  duration_seconds: number | null;
  outcome: 'lead_captured' | 'transferred' | 'abandoned' | null;
  started_at: string;
  ended_at: string | null;
  tools_used: string[] | null;
  transcript: string | null;
  summary: string | null;
  lead_id: string | null;
  first_name: string | null;
  business_name: string | null;
  business_type: string | null;
}

export interface Lead {
  id: string;
  phone_number: string;
  first_name: string | null;
  business_name: string | null;
  business_type: string | null;
  callback_day: string | null;
  callback_time: string | null;
  appointment_id: string | null;
  sms_sent: boolean;
  transferred: boolean;
  created_at: string;
  updated_at: string;
  call_count?: number;
  calls?: Call[];
}

export interface Stats {
  period_days: number;
  total_calls: number;
  total_leads: number;
  leads_captured: number;
  calls_transferred: number;
  calls_abandoned: number;
  conversion_rate: number;
  avg_call_duration: number;
  daily_volume: { day: string; count: number }[];
  recent_leads: Pick<Lead, 'id' | 'first_name' | 'business_name' | 'phone_number' | 'created_at'>[];
}

export interface Settings {
  id: string;
  business_name: string;
  agent_name: string;
  greeting_style: string;
  transfer_hours_start: number;
  transfer_hours_end: number;
  transfer_timezone: string;
  booking_link: string;
  sms_enabled: boolean;
  auto_summary: boolean;
  custom_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaginatedCalls {
  calls: Call[];
  total: number;
  page: number;
  limit: number;
}

export interface PaginatedLeads {
  leads: Lead[];
  total: number;
  page: number;
  limit: number;
}

// ─── UI types ─────────────────────────────────────────────────────────────

export interface CallFilters {
  outcome?: string;
  from?: string;
  to?: string;
  page: number;
}

export interface LeadFilters {
  business_type?: string;
  search?: string;
  page: number;
}
