import React, { useState } from 'react';
import { X, Clock, Play, Square, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { RegisterSession } from '../types/database';
import { openRegisterSession, closeRegisterSession } from '../lib/supabase';

interface RegisterSessionModalProps {
  activeSession: RegisterSession | null;
  onClose: () => void;
  onSessionUpdated: (session: RegisterSession | null) => void;
}

export const RegisterSessionModal: React.FC<RegisterSessionModalProps> = ({
  activeSession,
  onClose,
  onSessionUpdated,
}) => {
  const [registerName, setRegisterName] = useState('Terminal 1');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleOpenSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registerName.trim()) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const session = await openRegisterSession(registerName.trim());
      onSessionUpdated(session);
      onClose();
    } catch (err: any) {
      console.error('Failed to open register session:', err);
      setErrorMsg(err.message || 'Failed to open register session.');
    } finally {
      setLoading(false);
    }
  };

  const handleCloseSession = async () => {
    if (!activeSession) return;
    if (!confirm(`Are you sure you want to close session '${activeSession.register_name}'?`)) return;

    setLoading(true);
    setErrorMsg(null);

    try {
      await closeRegisterSession(activeSession.id);
      onSessionUpdated(null);
      onClose();
    } catch (err: any) {
      console.error('Failed to close session:', err);
      setErrorMsg(err.message || 'Failed to close register session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-md p-6 shadow-xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3 mb-5">
          <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Register Session Control</h2>
            <p className="text-xs text-slate-500">Manage cashier checkout shift and audit sessions</p>
          </div>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        {activeSession ? (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Status</span>
                <span className="inline-flex items-center text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-600" /> ACTIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Register Name</span>
                <span className="text-xs font-semibold text-slate-900">{activeSession.register_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Opened At</span>
                <span className="text-xs font-mono text-slate-700">
                  {new Date(activeSession.opened_at).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Expires At</span>
                <span className="text-xs font-mono text-slate-700">
                  {new Date(activeSession.expires_at).toLocaleTimeString()}
                </span>
              </div>
            </div>

            <button
              onClick={handleCloseSession}
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-semibold text-xs flex items-center justify-center space-x-2 transition-colors disabled:opacity-50"
            >
              <Square className="w-4 h-4" />
              <span>{loading ? 'Closing Session...' : 'Close Register Session'}</span>
            </button>
          </div>
        ) : (
          <form onSubmit={handleOpenSession} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Register Terminal Name
              </label>
              <input
                type="text"
                required
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                placeholder="e.g. Counter 1, Express Lane..."
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Opens an active 16-hour session required by PostgreSQL RLS for processing checkouts.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-xs flex items-center justify-center space-x-2 transition-colors disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              <span>{loading ? 'Opening Session...' : 'Open Register Session'}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
