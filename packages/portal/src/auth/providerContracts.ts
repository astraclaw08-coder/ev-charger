export type AuthProvider = 'google' | 'apple';

export const AUTH_PROVIDER_LABELS: Record<AuthProvider, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
};

export type AuthProviderContract = {
  provider: AuthProvider;
  strategy: 'oauth_google' | 'oauth_apple';
  redirectUrl: string;
};

export function buildAuthProviderContract(
  provider: AuthProvider,
  redirectUrl = '/'
): AuthProviderContract {
  return {
    provider,
    strategy: provider === 'google' ? 'oauth_google' : 'oauth_apple',
    redirectUrl,
  };
}
