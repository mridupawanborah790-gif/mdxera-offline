import React from 'react';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './providers/AuthProvider';
import { SyncProvider } from './providers/SyncProvider';
import { AppRouter } from './Router';
import Sidebar from '@core/components/layout/Sidebar';
import Header from '@core/components/layout/Header';
import StatusBar from '@core/components/layout/StatusBar';
import Auth from '@core/auth/components/Auth';
import { useAuthStore } from '@core/auth/authStore';
import { login } from '@core/auth/authService';
import { triggerFullResync } from '@core/sync/SyncBootstrap';
import type { RegisteredPharmacy } from '@core/types';

function AppShell() {
  const { setUser } = useAuthStore();

  const handleLogin = (user: RegisteredPharmacy) => setUser(user);

  return (
    <AuthProvider
      loginFallback={<Auth onLogin={handleLogin} />}
      loadingFallback={
        <div className="flex items-center justify-center h-screen bg-gray-900 text-gray-300 text-sm">
          Starting MDXera ERP…
        </div>
      }
    >
      <SyncProvider>
        <div className="flex h-screen overflow-hidden bg-gray-50">
          <Sidebar />
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <Header onResyncAll={triggerFullResync} />
            <main className="flex-1 overflow-auto">
              <AppRouter />
            </main>
            <StatusBar />
          </div>
        </div>
      </SyncProvider>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
