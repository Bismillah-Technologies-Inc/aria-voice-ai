import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { Call } from '../types';

interface CallSummary {
  summary?: string;
  lead_quality?: string;
  next_action?: string;
  business_type?: string;
  pain_points?: string[];
}

const QUALITY_COLORS: Record<string, string> = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-yellow-100 text-yellow-700',
  cold: 'bg-blue-100 text-blue-700',
};

function parseSummary(raw: string | null): CallSummary {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CallSummary;
  } catch {
    return { summary: raw };
  }
}

export function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    apiGet<Call>(`/api/calls/${id}`)
      .then(setCall)
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

  if (!call) {
    return <div className="p-8 text-gray-400 text-sm">Loading…</div>;
  }

  const summary = parseSummary(call.summary);

  return (
    <div className="p-8 max-w-4xl">
      <button onClick={() => navigate(-1)} className="text-sm text-brand-600 hover:underline mb-6 block">
        ← Back to Calls
      </button>

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Call Detail</h2>
        <p className="text-gray-500 text-sm">
          {new Date(call.started_at).toLocaleString()} · {call.phone_number}
        </p>
      </div>

      {/* Meta row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Outcome</p>
          <p className="font-semibold capitalize mt-1">{call.outcome?.replace('_', ' ') || '—'}</p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Duration</p>
          <p className="font-semibold mt-1">
            {call.duration_seconds
              ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
              : '—'}
          </p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Lead</p>
          <p className="font-semibold mt-1">
            {call.lead_id ? (
              <Link to={`/leads/${call.lead_id}`} className="text-brand-600 hover:underline">
                {call.first_name || call.business_name || 'View lead'}
              </Link>
            ) : '—'}
          </p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Tools Used</p>
          <p className="font-semibold mt-1">{call.tools_used?.length ?? 0}</p>
        </div>
      </div>

      {/* AI Summary */}
      {summary.summary && (
        <div className="bg-white rounded-xl border p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">AI Summary</h3>
            {summary.lead_quality && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${QUALITY_COLORS[summary.lead_quality] || 'bg-gray-100 text-gray-600'}`}>
                {summary.lead_quality.toUpperCase()} lead
              </span>
            )}
          </div>
          <p className="text-sm text-gray-700">{summary.summary}</p>
          {summary.next_action && (
            <p className="text-sm text-gray-500 mt-2">
              <span className="font-medium">Next action:</span> {summary.next_action}
            </p>
          )}
          {summary.pain_points?.length ? (
            <div className="mt-3">
              <p className="text-xs text-gray-500 font-medium mb-1">Pain points</p>
              <div className="flex flex-wrap gap-1">
                {summary.pain_points.map((p) => (
                  <span key={p} className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Tools used */}
      {call.tools_used?.length ? (
        <div className="bg-white rounded-xl border p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Tools Used by Aria</h3>
          <div className="flex flex-wrap gap-2">
            {call.tools_used.map((t) => (
              <span key={t} className="px-2 py-1 bg-brand-50 text-brand-700 rounded text-xs font-medium">
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Transcript */}
      {call.transcript && (
        <div className="bg-white rounded-xl border p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Full Transcript</h3>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono leading-relaxed bg-gray-50 rounded-lg p-4 overflow-auto max-h-96">
            {call.transcript}
          </pre>
        </div>
      )}
    </div>
  );
}
