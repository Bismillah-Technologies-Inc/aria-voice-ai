import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { apiGet } from '../api/client';
import { StatsCard } from '../components/StatsCard';
import type { Stats } from '../types';

const PERIODS = [
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
];

function fmtDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [period, setPeriod] = useState('30');
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    apiGet<Stats>('/api/stats', { days: period })
      .then(setStats)
      .catch((e: Error) => setError(e.message));
  }, [period]);

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Overview</h2>
          <p className="text-gray-500 text-sm">How Aria is performing</p>
        </div>
        <div className="flex gap-2">
          {PERIODS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setPeriod(value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === value
                  ? 'bg-brand-600 text-white'
                  : 'bg-white border hover:bg-gray-50 text-gray-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatsCard
          label="Total Calls"
          value={stats?.total_calls ?? '—'}
          sub={`Last ${period} days`}
          color="blue"
        />
        <StatsCard
          label="Leads Captured"
          value={stats?.leads_captured ?? '—'}
          sub={`${stats?.conversion_rate ?? '—'}% conversion`}
          color="green"
        />
        <StatsCard
          label="Transferred to Human"
          value={stats?.calls_transferred ?? '—'}
          color="yellow"
        />
        <StatsCard
          label="Avg Call Duration"
          value={stats ? fmtDuration(stats.avg_call_duration) : '—'}
          color="blue"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Daily volume chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Call Volume</h3>
          {stats?.daily_volume?.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.daily_volume} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => fmtDate(v)}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  formatter={(v) => [v, 'Calls']}
                  labelFormatter={(l) => fmtDate(l as string)}
                />
                <Bar dataKey="count" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">
              No call data for this period
            </div>
          )}
        </div>

        {/* Outcome breakdown */}
        <div className="bg-white rounded-xl border p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Outcomes</h3>
          {stats ? (
            <div className="space-y-3">
              {[
                { label: 'Lead Captured', value: stats.leads_captured, color: 'bg-green-500' },
                { label: 'Transferred', value: stats.calls_transferred, color: 'bg-yellow-500' },
                { label: 'Abandoned', value: stats.calls_abandoned, color: 'bg-red-400' },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600">{label}</span>
                    <span className="font-medium">{value}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${color} rounded-full`}
                      style={{
                        width: stats.total_calls
                          ? `${(value / stats.total_calls) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-400 text-sm">Loading…</div>
          )}
        </div>
      </div>

      {/* Recent leads */}
      {stats?.recent_leads?.length ? (
        <div className="bg-white rounded-xl border">
          <div className="px-5 py-4 border-b">
            <h3 className="text-sm font-semibold text-gray-700">Recent Leads</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Business</th>
                <th className="px-5 py-3 font-medium">Phone</th>
                <th className="px-5 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent_leads.map((lead) => (
                <tr key={lead.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">{lead.first_name || '—'}</td>
                  <td className="px-5 py-3 text-gray-600">{lead.business_name || '—'}</td>
                  <td className="px-5 py-3 text-gray-600">{lead.phone_number}</td>
                  <td className="px-5 py-3 text-gray-400">{fmtDate(lead.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
