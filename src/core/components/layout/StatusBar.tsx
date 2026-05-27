
import React, { useState, useEffect } from 'react';

import { AppConfigurations } from '@core/types';
import { resolveFiscalYearConfig } from '@core/utils/fiscalYear';
import SyncIndicator from '@core/components/feedback/SyncIndicator';
import BackgroundSyncBadge from '@core/components/feedback/BackgroundSyncBadge';
import { getCurrentVersion } from '@core/updates/updateService';

interface StatusBarProps {
  userName: string;
  isOnline: boolean;
  pharmacyName: string;
  isSyncing?: boolean;
  appEdition?: string;
  configurations?: AppConfigurations;
}

const StatusBar: React.FC<StatusBarProps> = ({ userName, isOnline, pharmacyName, isSyncing, appEdition = 'Enterprise Edition', configurations }) => {
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentVersion()
      .then(v => { if (!cancelled) setAppVersion(v); })
      .catch(() => { /* leave blank — better than a stale hardcoded number */ });
    return () => { cancelled = true; };
  }, []);

  const isLive = appEdition.toLowerCase().includes('[live]');
  const fy = resolveFiscalYearConfig(configurations).currentFiscalYear;

  return (
    <div className="h-8 bg-primary text-white flex items-center px-4 text-[13px] font-bold border-t border-white/10 flex-shrink-0 z-50 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
            {/* Offline trumps syncing: realtime drops when the network does, so
                `isSyncing` (which is driven partly by !isRealtimeActive) would
                otherwise stick on "Synchronizing..." forever while offline. */}
            <span className={`w-2.5 h-2.5 rounded-full ${!isOnline ? 'bg-red-500' : (isSyncing ? 'bg-accent animate-spin' : 'bg-emerald-400 animate-pulse')}`}></span>
            <span className="uppercase tracking-widest text-[10px]">
                {!isOnline ? 'Local Workspace' : (isSyncing ? 'Synchronizing...' : 'Network Connected')}
            </span>
        </div>
        
        {isLive && (
            <div className="flex items-center gap-1.5 ml-2 bg-white/10 px-2 py-0.5 rounded border border-white/5 animate-in fade-in duration-500">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-ping"></div>
                <span className="text-[9px] font-black uppercase tracking-tighter text-accent">Realtime</span>
            </div>
        )}
        
        <div className="h-4 w-px bg-white/20"></div>
        
        <div className="flex items-center gap-2">
            <span className="opacity-60 uppercase text-[10px]">F.Y.:</span>
            <span className="text-gray-200">{fy}</span>
        </div>

        <div className="h-4 w-px bg-white/20"></div>

        {/* Initial sync background badge (only visible during background phase) */}
        <BackgroundSyncBadge />

        {/* Sync health indicator — click to see the queue + retry/discard */}
        <div className="bg-white/10 px-2 py-0.5 rounded border border-white/10">
          <SyncIndicator />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="opacity-60 uppercase text-[10px]">Company:</span>
            <span className="text-accent uppercase tracking-tighter">{pharmacyName} — {appEdition}{appVersion ? ` (v${appVersion})` : ''}</span>
          </div>
          <div className="flex items-center gap-2 border-l border-white/10 pl-6 h-full">
            <span className="opacity-60 uppercase text-[10px]">Operator:</span>
            <span className="uppercase">{userName}</span>
          </div>
          <div className="font-mono bg-white/10 px-2.5 py-0.5 rounded-none text-[12px] border border-white/10">{time}</div>
      </div>
    </div>
  );
};

export default StatusBar;
