import { Link } from 'react-router-dom';
import { AUTH_PROVIDER_LABELS, type AuthProvider } from '../auth/providerContracts';
import { useAuthUx } from '../auth/AuthUxContext';

type LoginProps = {
  error?: string;
  devMode?: boolean;
  devOperatorId?: string;
  onDevSignIn?: () => void;
};

export default function Login({ error, devMode = false, devOperatorId = 'operator-001', onDevSignIn }: LoginProps) {
  const { sessionStatus, providerLoading, providerEnabled, signInWithProvider, lastError } = useAuthUx();

  const resolvedError = error ?? lastError;

  function providerButton(provider: AuthProvider) {
    const loading = providerLoading === provider;
    const disabled = !providerEnabled || providerLoading !== null || sessionStatus === 'loading';

    return (
      <button
        key={provider}
        type="button"
        disabled={disabled}
        onClick={() => signInWithProvider(provider)}
        className="w-full rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-70"
      >
        {loading ? `Starting ${provider} sign-in...` : `${AUTH_PROVIDER_LABELS[provider]}${providerEnabled ? '' : ' (coming soon)'}`}
      </button>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">⚡ EV Charger Portal</h1>
          <p className="mt-1 text-sm text-gray-500">Enterprise login</p>
        </div>

        <div className="space-y-3">
          {(['google', 'apple'] as const).map(providerButton)}
          {devMode && (
            <button
              type="button"
              onClick={onDevSignIn}
              className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500"
            >
              Dev Mode — sign in as {devOperatorId}
            </button>
          )}
        </div>

        <div
          role="alert"
          aria-live="polite"
          className="mt-4 min-h-10 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {resolvedError ?? (providerEnabled
            ? 'Choose a provider to continue.'
            : devMode
              ? 'Development mode: use the dev sign-in button to preview the full login shell and then enter the app.'
              : 'Authentication providers are not wired yet. This is a frontend contract/hook phase.')}
        </div>

        <p className="mt-4 text-center text-xs text-gray-500">
          Dev mode bypass available on local environments.
          <br />
          <Link to="/" className="font-medium text-brand-700 hover:underline">
            Go to dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}
