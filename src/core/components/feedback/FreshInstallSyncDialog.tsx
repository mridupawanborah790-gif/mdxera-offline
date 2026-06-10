import React from 'react';

interface Props {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FreshInstallSyncDialog: React.FC<Props> = ({ isOpen, onConfirm, onCancel }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-[9999] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded shadow-2xl max-w-md w-full overflow-hidden flex flex-col my-auto border border-red-200">
        <div className="bg-red-50 px-6 py-4 border-b border-red-100 flex items-center gap-3">
          <svg className="text-red-600 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <path d="M12 9v4"/>
            <path d="M12 17h.01"/>
          </svg>
          <h2 className="text-lg font-bold text-red-700">Fresh Install Sync</h2>
        </div>
        
        <div className="p-6">
          <p className="text-sm text-gray-800 mb-4 font-semibold">
            Are you sure you want to completely wipe your local data and perform a fresh install sync?
          </p>
          <p className="text-sm text-gray-600 mb-4">
            This will <span className="font-bold text-red-600">delete all locally cached tables</span> and re-download everything from the server.
          </p>
          <ul className="text-sm text-gray-600 list-disc pl-5 mb-4 space-y-1">
            <li>Any <span className="font-bold">unsynced local changes</span> that failed to push will be preserved.</li>
            <li>This process may take several minutes depending on the size of your database.</li>
            <li>Your application will be locked during the foreground phase.</li>
          </ul>
        </div>
        
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-bold bg-white hover:bg-gray-100 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
            }}
            className="px-4 py-2 bg-red-600 text-white text-sm font-bold hover:bg-red-700 rounded shadow-sm"
          >
            Yes, Sync Fresh
          </button>
        </div>
      </div>
    </div>
  );
};

export default FreshInstallSyncDialog;
