import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { Lead } from '../types';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtDuration(s: number | null): string {
  if (!s) return '—';
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    apiGet<Lead>(`/api/leads/${id}`)
      .then(setLead)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
        <button onClick={() => navigate(-1)} className="mt-4 text-sm text-brand-600 hover:underline">
          ← Back
        </button>
      </div>
    );
  }

  if (!lead) return <div className="p-8 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="p-8 max-w-3xl">
      <button onClick={() => navigate(-1)} className="text-sm text-brand-600 hover:underline mb-6 block">
        ← Back to Leads
      </button>

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">
          {lead.first_name || lead.business_name || lead.phone_number}
        </h2>
        <p className="text-gray-500 text-sm">Added {fmtDate(lead.created_at)}</p>
      </div>

      {/* Lead info */}
      <div className="bg-white rounded-xl border p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Contact Information</h3>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          {[
            { label: 'Name', value: lead.first_name },
            { label: 'Business', value: lead.business_name },
            { label: 'Type', value: lead.business_type },
            { label: 'Phone', value: lead.phone_number },
            { label: 'Callback Day', value: lead.callback_day },
            { label: 'Callback Time', value: lead.callback_time },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt className="text-gray-500">{label}</dt>
              <dd className="font-medium mt-0.5">{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Status badges */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Status</h3>
        <div className="flex gap-2 flex-wrap">
          {lead.appointment_id ? (
            <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
              ✓ Appointment Booked
            </span>
          ) : (
            <span className="px-3 py-1 bg-gray-100 text-gray-500 rounded-full text-sm">
              No appointment
            </span>
          )}
          {lead.transferred && (
            <span className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full text-sm font-medium">
              Transferred to human
            </span>
          )}
          {lead.sms_sent && (
            <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
              SMS sent
            </span>
          )}
        </div>
      </div>

      {/* Associated calls */}
      {lead.calls?.length ? (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b">
            <h3 className="text-sm font-semibold text-gray-700">
              Calls ({lead.calls.length})
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Duration</th>
                <th className="px-5 py-3 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {lead.calls.map((call) => (
                <tr key={call.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <Link to={`/calls/${call.id}`} className="text-brand-600 hover:underline">
                      {fmtDate(call.started_at)}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-gray-600">{fmtDuration(call.duration_seconds)}</td>
                  <td className="px-5 py-3 capitalize text-gray-600">
                    {call.outcome?.replace('_', ' ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-xl border p-5 text-gray-400 text-sm">
          No calls associated with this lead
        </div>
      )}
    </div>
  );
}
