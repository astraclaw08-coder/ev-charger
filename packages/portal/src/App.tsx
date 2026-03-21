import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { HybridTokenProvider, PasswordTokenProvider, DevTokenProvider } from './auth/TokenContext';
import { ClerkAuthUxProvider, DevAuthUxProvider } from './auth/AuthUxContext';
import { PasswordAuthProvider, usePasswordAuth } from './auth/PasswordAuthContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Sites from './pages/Sites';
import SiteDetail from './pages/SiteDetail';
import Analytics from './pages/Analytics';
import FleetAnalytics from './pages/FleetAnalytics';
import ChargerDetail from './pages/ChargerDetail';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import CustomerSupport from './pages/CustomerSupport';
import NetworkOps from './pages/NetworkOps';
import LoadManagement from './pages/LoadManagement';
import UserManagement from './pages/UserManagement';
import Settings from './pages/Settings';
import Notifications from './pages/Notifications';
import Operations from './pages/Operations';
import Chargers from './pages/Chargers';
import Sessions from './pages/Sessions';
import { ThemeProvider, usePortalTheme } from './theme/ThemeContext';
import { PortalScopeProvider } from './context/PortalScopeContext';
import { getDefaultHomePath, getRolePreference } from './lib/portalPreferences';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const AUTH_MODE = String(import.meta.env.VITE_AUTH_MODE ?? '').trim().toLowerCase();
const DEV_LOGIN_FLAG_KEY = 'portal.dev.signedIn';

function resolveAuthMode(): 'dev' | 'keycloak' | 'clerk' {
  if (AUTH_MODE === 'dev' || AUTH_MODE === 'keycloak' || AUTH_MODE === 'clerk') return AUTH_MODE;
  return CLERK_KEY ? 'clerk' : 'keycloak';
}

function PortalRoutes() {
  const homePath = getDefaultHomePath(getRolePreference());

  return (
    <BrowserRouter>
      <PortalScopeProvider>
        <Layout>
          <Routes>
          <Route path="/" element={<Navigate to={homePath} replace />} />
          <Route path="/overview" element={<Dashboard />} />
          <Route path="/dashboard" element={<Navigate to="/overview" replace />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/sites/:id" element={<SiteDetail />} />
          <Route path="/analytics" element={<FleetAnalytics />} />
          <Route path="/sites/:id/analytics" element={<Analytics />} />
          <Route path="/chargers" element={<Chargers />} />
          <Route path="/chargers/:id" element={<ChargerDetail />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/support" element={<CustomerSupport />} />
          <Route path="/network" element={<NetworkOps />} />
          <Route path="/load-management" element={<LoadManagement />} />
          <Route path="/users" element={<UserManagement />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin" element={<Navigate to="/settings" replace />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </PortalScopeProvider>
    </BrowserRouter>
  );
}

function SignedOutRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/sso-callback" element={<Login error="Completing sign-in..." />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function ClerkOrPasswordApp() {
  const { isLoaded, isSignedIn } = useAuth();
  const { session } = usePasswordAuth();
  const isPasswordSignedIn = !!session && session.expiresAtMs > Date.now();

  if (!isLoaded) return null;

  if (isSignedIn || isPasswordSignedIn) {
    return (
      <HybridTokenProvider>
        <PortalRoutes />
      </HybridTokenProvider>
    );
  }

  return (
    <ClerkAuthUxProvider>
      <SignedOutRoutes />
    </ClerkAuthUxProvider>
  );
}

function KeycloakOnlyApp() {
  const { session } = usePasswordAuth();
  const isPasswordSignedIn = !!session && session.expiresAtMs > Date.now();

  if (isPasswordSignedIn) {
    return (
      <PasswordTokenProvider>
        <PortalRoutes />
      </PasswordTokenProvider>
    );
  }

  return (
    <DevAuthUxProvider>
      <SignedOutRoutes />
    </DevAuthUxProvider>
  );
}

function DevSignedOutRoutes({ onSignIn }: { onSignIn: () => void }) {
  const devOperatorId = import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001';

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login devMode devOperatorId={devOperatorId} onDevSignIn={onSignIn} />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/sso-callback" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function DevApp() {
  const [devSignedIn, setDevSignedIn] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.sessionStorage.getItem(DEV_LOGIN_FLAG_KEY) === '1';
  });

  function handleDevSignIn() {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(DEV_LOGIN_FLAG_KEY, '1');
    }
    setDevSignedIn(true);
  }

  return (
    <DevTokenProvider>
      <DevAuthUxProvider>
        <div className="sticky top-0 z-50 bg-yellow-400 px-4 py-1 text-center text-xs font-medium text-yellow-900">
          Dev mode — auth shell enabled · operator-id: {import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001'}
        </div>
        {devSignedIn ? <PortalRoutes /> : <DevSignedOutRoutes onSignIn={handleDevSignIn} />}
      </DevAuthUxProvider>
    </DevTokenProvider>
  );
}

function ThemedShell() {
  const { themeClass } = usePortalTheme();
  const authMode = resolveAuthMode();

  if (import.meta.env.VITE_FORCE_LOGIN_SCREEN === '1') {
    return (
      <div className={themeClass}>
        <BrowserRouter>
          <Routes>
            <Route path="*" element={<Login />} />
          </Routes>
        </BrowserRouter>
      </div>
    );
  }

  if (authMode === 'clerk' && CLERK_KEY) {
    return (
      <div className={themeClass}>
        <PasswordAuthProvider>
          <ClerkProvider publishableKey={CLERK_KEY}>
            <ClerkOrPasswordApp />
          </ClerkProvider>
        </PasswordAuthProvider>
      </div>
    );
  }

  if (authMode === 'keycloak') {
    return (
      <div className={themeClass}>
        <PasswordAuthProvider>
          <KeycloakOnlyApp />
        </PasswordAuthProvider>
      </div>
    );
  }

  return (
    <div className={themeClass}>
      <DevApp />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ThemedShell />
    </ThemeProvider>
  );
}
