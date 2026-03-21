import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export default function ResetPassword() {
  const [identifier, setIdentifier] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = identifier.trim();
    if (!value || loading) return;

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`${API_URL}/auth/password-reset-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: value }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (json as { error?: string }).error ?? 'Unable to submit password reset request';
        throw new Error(message);
      }

      setSuccess((json as { message?: string }).message ?? 'Check your email for password reset instructions.');
      setIdentifier('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to submit password reset request');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-50 dark:bg-slate-800/60 px-4 py-10 md:items-center">
      <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm">
        <div className="mb-6 text-center">
          <div className="flex justify-center">
            <BrandMark className="w-[264px]" />
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">Charger Management Software</p>
        </div>

        <form className="space-y-3" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label htmlFor="identifier" className="block text-sm font-medium text-gray-500 dark:text-slate-400">
              Email or username
            </label>
            <input
              id="identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter your email or username"
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-gray-700 dark:text-slate-300 placeholder:text-gray-500 dark:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !identifier.trim()}
            className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-70"
          >
            {loading ? 'Sending reset link...' : 'Send reset link'}
          </button>

          <p className="text-center text-xs text-gray-500 dark:text-slate-400">
            Remembered your password?{' '}
            <Link to="/login" className="font-medium text-brand-700 hover:underline">
              Back to login
            </Link>
          </p>
        </form>

        {success && (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-emerald-700">
            {success}
          </p>
        )}

        {error && (
          <p role="alert" aria-live="polite" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
