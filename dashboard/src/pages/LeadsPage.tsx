import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import { Pagination } from '../components/Pagination';
import type { PaginatedLeads, LeadFilters } from '../types';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function LeadsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<PaginatedLeads | null>(null);
  const [filters, setFilters] = useState<LeadFilters>({ page: 1 });
  const [error, setError] = useState('');

  useEffect(() => {
    const params: Record<string, string> = { page: String(filters.page) };
    if (filters.business_type) params.business_type = filters.business_type;
    if (filters.search) params.search = filters.search;

    apiGet<PaginatedLeads>('/api/leads', params)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [filters]);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Leads</h2>
        <p className="text-gray-500 text-sm">Everyone Aria has spoken with</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border p-4 mb-4 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search name, business, phone…"
          value={filters.search || ''}
          onChange={(e) => setFilters({ ...filters, search: e.target.value || undefined, page: 1 })}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500 w-64"
        />
        <select
          value={filters.business_type || ''}
          onChange={(e) => setFilters({ ...filters, business_type: e.target.value || undefined, page: 1 })}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All business types</option>
          <option value="HVAC">HVAC</option>
          <option value="plumbing">Plumbing</option>
          <option value="dental">Dental</option>
          <option value="legal">Legal</option>
          <option value="salon">Salon</option>
          <option value="other">Other</option>
        </select>
        {(filters.search || filters.business_type) && (
          <button
            onClick={() => setFilters({ page: 1 })}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Business</th>
              <th className="px-5 py-3 font-medium">Phone</th>
              <th className="px-5 py-3 font-medium">Calls</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Added</th>
            </tr>
          </thead>
          <tbody>
            {data?.leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => navigate(`/leads/${lead.id}`)}
                className="border-b last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <td className="px-5 py-3 font-medium">{lead.first_name || '—'}</td>
                <td className="px-5 py-3 text-gray-600">
                  <div>{lead.business_name || '—'}</div>
                  {lead.business_type && (
                    <div className="text-xs text-gray-400">{lead.business_type}</div>
                  )}
                </td>
                <td className="px-5 py-3 text-gray-600">{lead.phone_number}</td>
                <td className="px-5 py-3 text-gray-600">{lead.call_count ?? 0}</td>
                <td className="px-5 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {lead.appointment_id && (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">Booked</span>
                    )}
                    {lead.transferred && (
                      <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-xs">Transferred</span>
                    )}
                    {lead.sms_sent && (
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">SMS sent</span>
                    )}
                    {!lead.appointment_id && !lead.transferred && !lead.sms_sent && (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </div>
                </td>
                <td className="px-5 py-3 text-gray-400">{fmtDate(lead.created_at)}</td>
              </tr>
            ))}
            {data?.leads.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-gray-400 text-sm">
                  No leads found
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {data && (
          <Pagination
            page={data.page}
            total={data.total}
            limit={data.limit}
            onPage={(p) => setFilters({ ...filters, page: p })}
          />
        )}
      </div>
    </div>
  );
}
