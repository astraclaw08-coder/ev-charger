import React, { useState } from 'react';
import { cn } from '../lib/utils';
import type { CreatedCharger } from '../api/client';

interface Props {
  siteId: string;
  onAdd: (body: {
    siteId: string;
    ocppId: string;
    serialNumber: string;
    model: string;
    vendor: string;
  }) => Promise<CreatedCharger>;
  onClose: () => void;
}

type Step = 'form' | 'success';

export default function AddChargerDialog({ siteId, onAdd, onClose }: Props) {
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<CreatedCharger | null>(null);

  const [form, setForm] = useState({
    ocppId: '',
    serialNumber: '',
    model: '',
    vendor: '',
  });

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await onAdd({ siteId, ...form });
      setCreated(result);
      setStep('success');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register charger');
    } finally {
      setLoading(false);
    }
  }

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {step === 'form' ? (
          <>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Register New Charger</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
              Enter the charger details. A password will be generated for OCPP authentication.
            </p>

            {error && (
              <div className="mt-3 rounded-md bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              {(
                [
                  { label: 'OCPP Identity (ocppId)', field: 'ocppId', placeholder: 'CP005' },
                  { label: 'Serial Number', field: 'serialNumber', placeholder: 'ABB-EVL9-005' },
                  { label: 'Model', field: 'model', placeholder: 'Terra 54' },
                  { label: 'Vendor', field: 'vendor', placeholder: 'ABB' },
                ] as const
              ).map(({ label, field, placeholder }) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">{label}</label>
                  <input
                    required
                    value={form[field]}
                    onChange={set(field)}
                    placeholder={placeholder}
                    className="mt-1 block w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
              ))}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800/60 px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className={cn(
                    'rounded-md px-4 py-2 text-sm font-medium text-white',
                    loading
                      ? 'bg-brand-400 cursor-not-allowed'
                      : 'bg-brand-600 hover:bg-brand-700',
                  )}
                >
                  {loading ? 'Registering…' : 'Register Charger'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-2xl">✅</span>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Charger Registered</h2>
            </div>
            <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">
              Configure your charger with the connection details below. The password is shown{' '}
              <strong>once</strong> — save it now.
            </p>

            <div className="mt-4 space-y-3 rounded-lg bg-gray-50 dark:bg-slate-800/60 p-4 font-mono text-sm">
              <div>
                <p className="text-xs font-sans font-medium text-gray-500 dark:text-slate-400 uppercase">OCPP Endpoint</p>
                <p className="mt-0.5 break-all text-gray-900 dark:text-slate-100">{created?.ocppEndpoint}</p>
              </div>
              <div>
                <p className="text-xs font-sans font-medium text-gray-500 dark:text-slate-400 uppercase">Identity</p>
                <p className="mt-0.5 text-gray-900 dark:text-slate-100">{created?.ocppId}</p>
              </div>
              <div>
                <p className="text-xs font-sans font-medium text-gray-500 dark:text-slate-400 uppercase">Password</p>
                <p className="mt-0.5 font-bold text-red-700 dark:text-red-400">{created?.password}</p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="mt-4 w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
