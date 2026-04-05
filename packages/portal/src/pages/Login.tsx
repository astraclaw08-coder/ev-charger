import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { usePasswordAuth } from '../auth/PasswordAuthContext';
import BrandMark from '../components/BrandMark';

type LoginProps = {
  error?: string;
  devMode?: boolean;
  devOperatorId?: string;
  onDevSignIn?: () => void;
};

export default function Login({ error, devMode = false, devOperatorId = 'operator-001', onDevSignIn }: LoginProps) {
  const { loginWithPassword, loading: passwordLoading, error: passwordError } = usePasswordAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

  const passwordEnabled = !devMode;
  const resolvedError = error ?? passwordError;
  const resetPasswordUrl = (import.meta.env.VITE_PASSWORD_RESET_URL as string | undefined) ?? '/reset-password';
  const isInternalResetRoute = resetPasswordUrl.startsWith('/');

  async function onSubmitPassword(e: FormEvent) {
    e.preventDefault();
    if (!passwordEnabled) return;
    await loginWithPassword(username, password);
  }

  return (
    <div className="relative flex min-h-screen items-start justify-center px-4 py-10 md:items-center overflow-hidden bg-gray-50 dark:bg-slate-950">
      {/* Atmospheric background */}
      <div className="absolute inset-0 -z-10">
        {/* Gradient mesh */}
        <div className="absolute -top-1/4 -left-1/4 h-[600px] w-[600px] rounded-full bg-brand-500/8 dark:bg-brand-500/5 blur-[120px]" />
        <div className="absolute -bottom-1/4 -right-1/4 h-[500px] w-[500px] rounded-full bg-brand-400/6 dark:bg-brand-400/4 blur-[100px]" />
        {/* Subtle noise texture via CSS */}
        <div className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")', backgroundSize: '256px 256px' }} />
      </div>

      <div className="w-full max-w-md animate-in slide-up duration-300">
        {/* Card */}
        <div className="rounded-2xl border border-gray-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl p-8 shadow-xl shadow-gray-200/50 dark:shadow-black/30">
          {/* Brand */}
          <div className="mb-8 text-center">
            <div className="flex justify-center">
              <BrandMark className="w-[240px]" />
            </div>
            <p className="mt-3 text-sm text-gray-500 dark:text-slate-400 tracking-wide">Charger Management Platform</p>
          </div>

          <form className="space-y-4" onSubmit={onSubmitPassword}>
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:focus:ring-brand-400/20 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:focus:ring-brand-400/20 transition-colors"
              />
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-brand-600 focus:ring-brand-500 accent-brand-600"
              />
              <span className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">
                I agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
                  Terms of Service
                </a>{' '}
                and{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
                  Privacy Policy
                </a>
              </span>
            </label>

            <button
              type="submit"
              disabled={!passwordEnabled || passwordLoading || !username.trim() || !password || !consentChecked}
              className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-500 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              {!passwordEnabled ? 'Username/password disabled in dev mode' : passwordLoading ? 'Signing in…' : 'Sign in'}
            </button>

            <p className="text-center text-xs text-gray-500 dark:text-slate-400">
              Forgot your password?{' '}
              {isInternalResetRoute ? (
                <Link to={resetPasswordUrl} className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
                  Reset password
                </Link>
              ) : (
                <a href={resetPasswordUrl} className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
                  Reset password
                </a>
              )}
            </p>

            {devMode && (
              <button
                type="button"
                onClick={onDevSignIn}
                className="w-full rounded-lg border border-brand-200 dark:border-brand-700 bg-brand-50 dark:bg-brand-500/10 px-4 py-2.5 text-sm font-semibold text-brand-700 dark:text-brand-300 transition-all hover:bg-brand-100 dark:hover:bg-brand-500/20 active:scale-[0.98]"
              >
                Dev Mode — sign in as {devOperatorId}
              </button>
            )}
          </form>

          {resolvedError && (
            <div role="alert" aria-live="polite" className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {resolvedError}
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-gray-400 dark:text-slate-600">
          OCPP 1.6J · Lumeo Power
        </p>
      </div>
    </div>
  );
}
