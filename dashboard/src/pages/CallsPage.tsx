import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import { Pagination } from '../components/Pagination';
import type { PaginatedCalls, CallFilters } from '../types';

const OUTCOME_LABELS: Record<string, { label: string; color: string }> = {
  lead_captured: { label: 'Lead Captured', color: 'bg-green-100 text-green-700' },
  transferred: { label: 'Transferred', color: 'bg-yellow-100 text-yellow-700' },
  abandoned: { label: 'Abandoned', color: 'bg-red-100 text-red-700' },
};

function fmtDuration(s: number | null): string {
  if (!s) return '—';
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function CallsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<PaginatedCalls | null>(null);
  const [filters, setFilters] = useState<CallFilters>({ page: 1 });
  const [error, setError] = useState('');

  useEffect(() => {
    const params: Record<string, string> = { page: String(filters.page) };
    if (filters.outcome) params.outcome = filters.outcome;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;

    apiGet<PaginatedCalls>('/api/calls', params)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [filters]);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Call Log</h2>
        <p className="text-gray-500 text-sm">Every call Aria has handled</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border p-4 mb-4 flex flex-wrap gap-3">
        <select
          value={filters.outcome || ''}
          onChange={(e) => setFilters({ ...filters, outcome: e.target.value || undefined, page: 1 })}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All outcomes</option>
          <option value="lead_captured">Lead Captured</option>
          <option value="transferred">Transferred</option>
          <option value="abandoned">Abandoned</option>
        </select>
        <input
          type="date"
          value={filters.from || ''}
          onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined, page: 1 })}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="date"
          value={filters.to || ''}
          onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined, page: 1 })}
          className="border rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {(filters.outcome || filters.from || filters.to) && (
          <button
            onClick={() => setFilters({ page: 1 })}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Clear filters
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
              <th className="px-5 py-3 font-medium">Date</th>
              <th className="px-5 py-3 font-medium">Caller</th>
              <th className="px-5 py-3 font-medium">Lead</th>
              <th className="px-5 py-3 font-medium">Duration</th>
              <th className="px-5 py-3 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data?.calls.map((call) => (
              <tr
                key={call.id}
                onClick={() => navigate(`/calls/${call.id}`)}
                className="border-b last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <td className="px-5 py-3 text-gray-600">{fmtDate(call.started_at)}</td>
                <td className="px-5 py-3">{call.phone_number}</td>
                <td className="px-5 py-3 text-gray-600">
                  {call.first_name || call.business_name || '—'}
                </td>
                <td className="px-5 py-3 text-gray-600">{fmtDuration(call.duration_seconds)}</td>
                <td className="px-5 py-3">
                  {call.outcome ? (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_LABELS[call.outcome]?.color || 'bg-gray-100 text-gray-600'}`}>
                      {OUTCOME_LABELS[call.outcome]?.label || call.outcome}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            ))}
            {data?.calls.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-400 text-sm">
                  No calls found
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
