import { useEffect, useState, FormEvent } from 'react';
import { apiGet, apiPut } from '../api/client';
import type { Settings } from '../types';

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Partial<Settings>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<Settings>('/api/settings')
      .then((s) => {
        setSettings(s);
        setForm(s);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await apiPut<Settings>('/api/settings', form);
      setSettings(updated);
      setForm(updated);
      showToast('Settings saved', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const field = (
    key: keyof Settings,
    label: string,
    type: 'text' | 'number' | 'checkbox' | 'textarea' = 'text',
    hint?: string,
  ) => {
    if (type === 'checkbox') {
      return (
        <label key={key} className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={!!form[key]}
            onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          <div>
            <span className="text-sm font-medium text-gray-700">{label}</span>
            {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
          </div>
        </label>
      );
    }

    if (type === 'textarea') {
      return (
        <div key={key}>
          <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
          {hint && <p className="text-xs text-gray-500 mb-1">{hint}</p>}
          <textarea
            value={(form[key] as string) || ''}
            onChange={(e) => setForm({ ...form, [key]: e.target.value || null })}
            rows={4}
            placeholder="Leave blank to use Aria's default prompt"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
          />
        </div>
      );
    }

    return (
      <div key={key}>
        <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
        {hint && <p className="text-xs text-gray-500 mb-1">{hint}</p>}
        <input
          type={type}
          value={(form[key] as string | number) ?? ''}
          onChange={(e) =>
            setForm({
              ...form,
              [key]: type === 'number' ? parseInt(e.target.value, 10) : e.target.value,
            })
          }
          className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
    );
  };

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!settings) return <div className="p-8 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="p-8 max-w-2xl">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 ${
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900">Agent Settings</h2>
        <p className="text-gray-500 text-sm mt-1">
          Configure how Aria behaves on every call
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Business identity */}
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-4 pb-2 border-b">
            Business Identity
          </h3>
          <div className="grid grid-cols-2 gap-4">
            {field('business_name', 'Business Name', 'text', 'How callers will hear it introduced')}
            {field('agent_name', 'Agent Name', 'text', 'Name Aria will use for itself')}
          </div>
          <div className="mt-4">
            {field('booking_link', 'Booking Link', 'text', 'URL sent in SMS for appointment booking')}
          </div>
        </section>

        {/* Transfer hours */}
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-4 pb-2 border-b">
            Human Transfer Hours
          </h3>
          <div className="grid grid-cols-3 gap-4">
            {field('transfer_hours_start', 'Start Hour (24h)', 'number')}
            {field('transfer_hours_end', 'End Hour (24h)', 'number')}
            {field('transfer_timezone', 'Timezone', 'text')}
          </div>
        </section>

        {/* Features */}
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-4 pb-2 border-b">Features</h3>
          <div className="space-y-4">
            {field('sms_enabled', 'Enable post-call SMS', 'checkbox', 'Send a personalized SMS after every call')}
            {field('auto_summary', 'Auto-generate call summaries', 'checkbox', 'Use AI to summarize calls after they end')}
          </div>
        </section>

        {/* Custom prompt */}
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-4 pb-2 border-b">
            Custom System Prompt
          </h3>
          {field('custom_prompt', 'Override Prompt', 'textarea',
            'Advanced: replaces Aria\'s default system prompt. Leave blank for default behavior.')}
        </section>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          <button
            type="button"
            onClick={() => setForm(settings)}
            className="px-5 py-2 bg-white border hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors"
          >
            Discard Changes
          </button>
        </div>
      </form>
    </div>
  );
}
