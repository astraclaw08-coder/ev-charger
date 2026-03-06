import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { HybridTokenProvider, DevTokenProvider } from './auth/TokenContext';
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
import CustomerSupport from './pages/CustomerSupport';
import NetworkOps from './pages/NetworkOps';
import UserManagement from './pages/UserManagement';
import Settings from './pages/Settings';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const DEV_LOGIN_FLAG_KEY = 'portal.dev.signedIn';

function PortalRoutes() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/sites/:id" element={<SiteDetail />} />
          <Route path="/analytics" element={<FleetAnalytics />} />
          <Route path="/sites/:id/analytics" element={<Analytics />} />
          <Route path="/chargers/:id" element={<ChargerDetail />} />
          <Route path="/support" element={<CustomerSupport />} />
          <Route path="/network" element={<NetworkOps />} />
          <Route path="/users" element={<UserManagement />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

function SignedOutRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
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

function DevSignedOutRoutes({ onSignIn }: { onSignIn: () => void }) {
  const devOperatorId = import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001';

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login devMode devOperatorId={devOperatorId} onDevSignIn={onSignIn} />} />
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

export default function App() {
  if (import.meta.env.VITE_FORCE_LOGIN_SCREEN === '1') {
    return (
      <div className="portal-dark">
        <BrowserRouter>
          <Routes>
            <Route path="*" element={<Login />} />
          </Routes>
        </BrowserRouter>
      </div>
    );
  }

  if (CLERK_KEY) {
    return (
      <div className="portal-dark">
        <PasswordAuthProvider>
          <ClerkProvider publishableKey={CLERK_KEY}>
            <ClerkOrPasswordApp />
          </ClerkProvider>
        </PasswordAuthProvider>
      </div>
    );
  }

  return (
    <div className="portal-dark">
      <DevApp />
    </div>
  );
}
