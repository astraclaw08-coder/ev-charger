import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react';
import { ClerkTokenProvider, DevTokenProvider } from './auth/TokenContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SiteDetail from './pages/SiteDetail';
import Analytics from './pages/Analytics';
import ChargerDetail from './pages/ChargerDetail';
import Login from './pages/Login';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function PortalRoutes() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites/:id" element={<SiteDetail />} />
          <Route path="/sites/:id/analytics" element={<Analytics />} />
          <Route path="/chargers/:id" element={<ChargerDetail />} />
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
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function ClerkApp() {
  return (
    <>
      <SignedIn>
        <ClerkTokenProvider>
          <PortalRoutes />
        </ClerkTokenProvider>
      </SignedIn>
      <SignedOut>
        <SignedOutRoutes />
      </SignedOut>
    </>
  );
}

function DevApp() {
  return (
    <DevTokenProvider>
      <div className="sticky top-0 z-50 bg-yellow-400 px-4 py-1 text-center text-xs font-medium text-yellow-900">
        Dev mode — no auth · operator-id: {import.meta.env.VITE_DEV_OPERATOR_ID ?? 'operator-001'}
      </div>
      <PortalRoutes />
    </DevTokenProvider>
  );
}

export default function App() {
  if (CLERK_KEY) {
    return (
      <ClerkProvider publishableKey={CLERK_KEY}>
        <ClerkApp />
      </ClerkProvider>
    );
  }
  return <DevApp />;
}
