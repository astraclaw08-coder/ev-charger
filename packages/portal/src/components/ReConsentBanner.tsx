import { useEffect, useState } from 'react';

const CURRENT_TOS_VERSION = '1.0';
const CURRENT_PRIVACY_VERSION = '1.0';
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export default function ReConsentBanner() {
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void checkConsent();
  }, []);

  async function checkConsent() {
    try {
      const res = await fetch(`${API_URL}/me/consent`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.tosVersion !== CURRENT_TOS_VERSION || data.privacyVersion !== CURRENT_PRIVACY_VERSION) {
        setShow(true);
      }
    } catch {
      // Don't block on failure
    }
  }

  async function handleAccept() {
    setLoading(true);
    try {
      await fetch(`${API_URL}/me/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          tosVersion: CURRENT_TOS_VERSION,
          privacyVersion: CURRENT_PRIVACY_VERSION,
        }),
      });
      setShow(false);
    } catch {
      setShow(false);
    } finally {
      setLoading(false);
    }
  }

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-lg rounded-3xl border border-gray-200 bg-white p-8 shadow-2xl shadow-black/20 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-brand-600 dark:text-brand-400">Action required</p>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Updated legal terms</h2>
        <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-slate-300">
          We updated the Terms of Service and Privacy Policy. Review the latest documents and accept them to continue using the operator portal.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-2xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition hover:border-brand-400 hover:text-brand-700 dark:border-slate-700 dark:text-slate-200 dark:hover:border-brand-500 dark:hover:text-brand-300"
          >
            Terms of Service ↗
          </a>
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-2xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition hover:border-brand-400 hover:text-brand-700 dark:border-slate-700 dark:text-slate-200 dark:hover:border-brand-500 dark:hover:text-brand-300"
          >
            Privacy Policy ↗
          </a>
        </div>

        <button
          onClick={handleAccept}
          disabled={loading}
          className="mt-6 w-full rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Saving…' : 'I agree'}
        </button>
      </div>
    </div>
  );
}
