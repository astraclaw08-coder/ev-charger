import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ClerkProvider, SignIn, SignedIn, SignedOut } from '@clerk/clerk-react';
import { ClerkTokenProvider, DevTokenProvider } from './auth/TokenContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SiteDetail from './pages/SiteDetail';
import Analytics from './pages/Analytics';
import ChargerDetail from './pages/ChargerDetail';

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
        </Routes>
      </Layout>
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
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <div className="w-full max-w-md">
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-bold text-gray-900">⚡ EV Charger Portal</h1>
              <p className="mt-1 text-sm text-gray-500">Operator management dashboard</p>
            </div>
            <SignIn routing="hash" />
          </div>
        </div>
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
