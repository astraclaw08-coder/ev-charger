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
    <div className="flex min-h-screen items-start justify-center bg-gray-50 dark:bg-slate-800/60 px-4 py-10 md:items-center">
      <div className="w-full max-w-md rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm">
        <div className="mb-6 text-center">
          <div className="flex justify-center">
            <BrandMark className="w-[264px]" />
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">Charger Management Software</p>
        </div>

        <form className="space-y-3" onSubmit={onSubmitPassword}>
          <div className="space-y-2">
            <label htmlFor="username" className="block text-sm font-medium text-gray-500 dark:text-slate-400">
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
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-gray-700 dark:text-slate-300 placeholder:text-gray-500 dark:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium text-gray-500 dark:text-slate-400">
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
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-gray-700 dark:text-slate-300 placeholder:text-gray-500 dark:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <button
            type="submit"
            disabled={!passwordEnabled || passwordLoading || !username.trim() || !password}
            className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-70"
          >
            {!passwordEnabled ? 'Username/password disabled in dev mode' : passwordLoading ? 'Signing in...' : 'Next'}
          </button>

          <p className="text-center text-xs text-gray-500 dark:text-slate-400">
            Forgot your password?{' '}
            {isInternalResetRoute ? (
              <Link to={resetPasswordUrl} className="font-medium text-brand-700 hover:underline">
                Reset password
              </Link>
            ) : (
              <a href={resetPasswordUrl} className="font-medium text-brand-700 hover:underline">
                Reset password
              </a>
            )}
          </p>

          {devMode && (
            <button
              type="button"
              onClick={onDevSignIn}
              className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500"
            >
              Dev Mode — sign in as {devOperatorId}
            </button>
          )}
        </form>

        {resolvedError && (
          <p role="alert" aria-live="polite" className="mt-3 text-sm text-red-600">
            {resolvedError}
          </p>
        )}
      </div>
    </div>
  );
}
