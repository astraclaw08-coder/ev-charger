import { Link } from 'react-router-dom';
import { AUTH_PROVIDER_LABELS, type AuthProvider } from '../auth/providerContracts';
import { useAuthUx } from '../auth/AuthUxContext';

function AppleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
      <path d="M16.21 12.565c.03 3.03 2.66 4.04 2.69 4.054-.022.073-.42 1.444-1.384 2.862-.832 1.226-1.696 2.448-3.056 2.473-1.336.024-1.764-.792-3.292-.792-1.529 0-2.003.768-3.268.816-1.313.05-2.313-1.316-3.152-2.538C3.037 16.95 1.71 12.41 3.471 9.365c.874-1.513 2.434-2.47 4.126-2.494 1.289-.024 2.505.864 3.292.864.786 0 2.263-1.07 3.815-.913.649.027 2.474.263 3.646 1.978-.095.06-2.177 1.267-2.14 3.765Zm-2.683-6.576c.697-.845 1.169-2.022 1.04-3.189-1.003.04-2.212.67-2.93 1.514-.644.744-1.21 1.94-1.057 3.083 1.119.087 2.251-.57 2.947-1.408Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h6.45a5.51 5.51 0 0 1-2.4 3.62v3h3.88c2.28-2.1 3.56-5.2 3.56-8.65Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3A7.2 7.2 0 0 1 12 19.2a7.2 7.2 0 0 1-6.77-4.97H1.22v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.23 14.23A7.2 7.2 0 0 1 4.85 12c0-.77.14-1.52.38-2.23V6.66H1.22A12 12 0 0 0 0 12c0 1.93.46 3.76 1.22 5.34l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.76 0 3.34.6 4.58 1.79l3.43-3.43A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.22 6.66l4.01 3.11A7.2 7.2 0 0 1 12 4.8Z"
      />
    </svg>
  );
}

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
        className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-70"
      >
        {!loading && (provider === 'apple' ? <AppleIcon /> : <GoogleIcon />)}
        <span>
          {loading ? `Starting ${provider} sign-in...` : `${AUTH_PROVIDER_LABELS[provider]}${providerEnabled ? '' : ' (coming soon)'}`}
        </span>
      </button>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-10 md:items-center">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">⚡ EV Charger Portal</h1>
          <p className="mt-1 text-sm text-gray-500">Enterprise login</p>
        </div>

        <div className="space-y-3">
          <div className="space-y-2">
            <label htmlFor="username" className="block text-sm font-medium text-gray-500">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              placeholder="Enter your username"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium text-gray-500">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {(['apple', 'google'] as const).map(providerButton)}

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
