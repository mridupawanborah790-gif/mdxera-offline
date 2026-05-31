import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { ADMIN_MODULE_VISIBILITY_PASSWORD } from '@core/utils/adminConfig';

interface AdminPasswordModalProps {
  isOpen: boolean;
  title?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const AdminPasswordModal: React.FC<AdminPasswordModalProps> = ({
  isOpen,
  title = 'Admin Authentication Required',
  onSuccess,
  onCancel,
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (password === ADMIN_MODULE_VISIBILITY_PASSWORD) {
      onSuccess();
    } else {
      setError('Incorrect password. Access denied.');
      setPassword('');
      inputRef.current?.focus();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      widthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        <div className="space-y-1">
          <p className="text-[11px] font-black text-gray-700 uppercase tracking-widest">
            This screen is locked.
          </p>
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">
            Enter the admin password to configure module visibility for this user.
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">
            Admin Password
          </label>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
            autoComplete="off"
            className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold bg-input-bg"
          />
          {error && (
            <p className="text-[10px] font-black text-red-600 uppercase tracking-widest mt-1">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-6 py-2 tally-border bg-white text-gray-600 font-black uppercase text-[10px] tracking-widest hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password}
            className="px-8 py-2 tally-button-primary uppercase text-[10px] font-black tracking-widest disabled:opacity-50"
          >
            Unlock
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default AdminPasswordModal;
