import React from 'react';
import type { RegisteredPharmacy } from '@core/types';
import UpdateChecker from '@core/updates/UpdateChecker';

interface SyncAndUpdatesProps {
    currentUser: RegisteredPharmacy | null;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    onResyncAll: () => void;
    onFreshInstallSync: () => void;
    onCancel: () => void;
}

const SyncAndUpdates: React.FC<SyncAndUpdatesProps> = ({
    currentUser,
    addNotification,
    onResyncAll,
    onFreshInstallSync,
    onCancel
}) => {
    return (
        <div className="p-6 max-w-4xl mx-auto space-y-8 select-none">
            {/* Header section */}
            <div className="flex items-center justify-between border-b-2 border-primary pb-3">
                <div>
                    <h2 className="text-xl font-black text-primary uppercase tracking-wider">Sync & Updates</h2>
                    <p className="text-xs text-gray-500 mt-1 uppercase font-bold">Manage local database synchronization and application builds</p>
                </div>
                <button
                    onClick={onCancel}
                    className="px-6 py-2 border-2 border-gray-400 text-gray-700 hover:text-black font-black uppercase text-[10px] tracking-widest hover:bg-gray-100 transition-all transform active:scale-95"
                >
                    Close
                </button>
            </div>

            {/* Sync Card */}
            <div className="bg-white border border-gray-300 p-6 space-y-6 shadow-sm">
                <div className="border-b border-gray-200 pb-2">
                    <h3 className="text-xs font-black text-gray-700 uppercase tracking-widest">Database Synchronization</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-3">
                        <h4 className="text-[11px] font-black uppercase tracking-wider text-primary">Option 1: Resume / Sync All</h4>
                        <p className="text-xs text-gray-600 leading-relaxed">
                            Downloads all recent changes from the server database without wiping your offline work. Safe to run during active operations.
                        </p>
                        <button
                            type="button"
                            onClick={onResyncAll}
                            className="px-6 py-3 bg-primary text-white font-black uppercase text-[10px] tracking-widest hover:bg-primary-dark transition-all transform active:scale-95 flex items-center gap-2"
                            title="Re-download every table from the server into local storage"
                        >
                            <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 4.79M9 9H4M9 9V4" />
                            </svg>
                            Sync All (Resume)
                        </button>
                    </div>

                    <div className="space-y-3 border-t md:border-t-0 md:border-l border-gray-200 pt-6 md:pt-0 md:pl-6">
                        <h4 className="text-[11px] font-black uppercase tracking-wider text-red-600">Option 2: Fresh Install Sync</h4>
                        <p className="text-xs text-gray-600 leading-relaxed">
                            Wipes the local database entirely and downloads a clean master copy from the server. Use this only if you experience data sync inconsistency.
                        </p>
                        <button
                            type="button"
                            onClick={onFreshInstallSync}
                            className="px-6 py-3 border-2 border-red-500 text-red-600 font-black uppercase text-[10px] tracking-widest hover:bg-red-50 transition-all transform active:scale-95 flex items-center gap-2"
                            title="Wipe local database and start fresh from Supabase"
                        >
                            <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            Fresh Install Sync
                        </button>
                    </div>
                </div>
            </div>

            {/* Update Checker Card */}
            <div className="bg-white border border-gray-300 p-6 shadow-sm">
                <UpdateChecker addNotification={addNotification} />
            </div>
        </div>
    );
};

export default SyncAndUpdates;
