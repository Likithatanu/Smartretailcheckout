import React, { useState, useEffect } from 'react';
import { signInRetailer, resendConfirmationEmail } from '../lib/supabase';
import { RegisterView } from './RegisterView';
import { 
  Store, 
  Lock, 
  Mail, 
  AlertCircle, 
  ArrowRight, 
  ShieldCheck, 
  Eye, 
  EyeOff, 
  RefreshCw, 
  UserPlus,
  CheckCircle2,
  X
} from 'lucide-react';

export interface AuthCallbackNotification {
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
  detail?: string;
  email?: string;
}

interface LoginViewProps {
  onLoginSuccess: () => void;
  callbackNotification?: AuthCallbackNotification | null;
  onClearCallbackNotification?: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ 
  onLoginSuccess,
  callbackNotification,
  onClearCallbackNotification,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Email confirmation recovery state
  const [isUnconfirmed, setIsUnconfirmed] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // If callback notification supplies an email, pre-fill it
  useEffect(() => {
    if (callbackNotification?.email && !email) {
      setEmail(callbackNotification.email);
    }
    if (callbackNotification?.type === 'warning') {
      setIsUnconfirmed(true);
    }
  }, [callbackNotification]);

  if (mode === 'register') {
    return (
      <RegisterView
        onSwitchToLogin={() => setMode('login')}
        onRegisterSuccess={onLoginSuccess}
      />
    );
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setResendStatus(null);
    setLoading(true);

    try {
      const data = await signInRetailer({
        email: email.trim(),
        password: password,
      });

      if (!data.user) {
        throw new Error('No user record returned from authentication.');
      }

      onLoginSuccess();
    } catch (err: any) {
      console.error('Login error:', err);
      const msg = err.message || '';
      if (msg.toLowerCase().includes('email not confirmed')) {
        setIsUnconfirmed(true);
        setErrorMsg('Email address has not been confirmed. Please check your inbox or click "Resend Confirmation Link" below to receive a fresh verification link.');
      } else if (msg.toLowerCase().includes('invalid login credentials')) {
        setIsUnconfirmed(false);
        setErrorMsg('Invalid email or password. Please verify your credentials.');
      } else {
        setIsUnconfirmed(false);
        setErrorMsg(msg || 'Authentication failed. Please check your network and credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    const targetEmail = email.trim();
    if (!targetEmail) {
      setResendStatus({
        type: 'error',
        message: 'Please enter your retailer email address above to receive a fresh confirmation link.',
      });
      return;
    }

    setResending(true);
    setResendStatus(null);

    try {
      const res = await resendConfirmationEmail(targetEmail);
      setResendStatus({
        type: 'success',
        message: res.message,
      });
      setErrorMsg(null);
    } catch (err: any) {
      setResendStatus({
        type: 'error',
        message: err.message || 'Failed to resend confirmation email.',
      });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-600 mb-3 shadow-sm">
            <Store className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">AI Smart Retail Checkout</h1>
          <p className="text-sm text-slate-500 mt-1">Retailer Terminal & POS Management</p>
        </div>

        {/* Login Card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100 text-xs font-medium">
            <div className="flex items-center space-x-2 text-slate-700">
              <ShieldCheck className="w-4 h-4 text-indigo-600" />
              <span>Authorized Retailer Access Only</span>
            </div>
            <button
              type="button"
              onClick={() => setMode('register')}
              className="text-indigo-600 hover:text-indigo-700 font-semibold transition-colors flex items-center space-x-1"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Register</span>
            </button>
          </div>

          {/* Callback Notification Banners (Expired Link, Confirmation Success, etc.) */}
          {callbackNotification && (
            <div
              className={`mb-4 p-3.5 rounded-xl border text-xs flex items-start justify-between space-x-2.5 ${
                callbackNotification.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : callbackNotification.type === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              <div className="flex items-start space-x-2 flex-1">
                {callbackNotification.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${callbackNotification.type === 'warning' ? 'text-amber-600' : 'text-rose-600'}`} />
                )}
                <div>
                  <div className="font-semibold">{callbackNotification.message}</div>
                  {callbackNotification.detail && (
                    <div className="text-[11px] opacity-90 mt-0.5 leading-relaxed">{callbackNotification.detail}</div>
                  )}
                </div>
              </div>
              {onClearCallbackNotification && (
                <button
                  type="button"
                  onClick={onClearCallbackNotification}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-black/5 transition-colors"
                  aria-label="Dismiss message"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Resend Confirmation Status */}
          {resendStatus && (
            <div
              className={`mb-4 p-3.5 rounded-xl border text-xs flex items-start space-x-2.5 ${
                resendStatus.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {resendStatus.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1 font-medium">{resendStatus.message}</div>
            </div>
          )}

          {/* Standard Login Error Message */}
          {errorMsg && (
            <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMsg}</div>
            </div>
          )}

          {/* Interactive Resend Confirmation Recovery Box */}
          {(isUnconfirmed || (callbackNotification && callbackNotification.type === 'warning')) && (
            <div className="mb-4 p-3.5 bg-amber-50/70 border border-amber-200 rounded-xl space-y-2">
              <div className="text-[11px] text-amber-800 font-medium">
                Need a new verification link? Enter your email address above and click below.
              </div>
              <button
                type="button"
                onClick={handleResendConfirmation}
                disabled={resending}
                className="w-full py-2 px-3 rounded-xl bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-semibold text-xs flex items-center justify-center space-x-1.5 transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resending ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Sending Fresh Link...</span>
                  </>
                ) : (
                  <>
                    <Mail className="w-3.5 h-3.5" />
                    <span>Resend Confirmation Link</span>
                  </>
                )}
              </button>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Retailer Email
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="retailer@store.com"
                  className="w-full pl-10 pr-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-10 pr-10 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm shadow-sm flex items-center justify-center space-x-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Sign In to Terminal</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Registration Option */}
          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <div className="flex items-center justify-center space-x-1.5 text-xs text-slate-600 mb-2">
              <span>New retailer or store staff?</span>
              <button
                type="button"
                onClick={() => setMode('register')}
                className="text-indigo-600 hover:text-indigo-700 font-semibold transition-colors"
              >
                Create Retailer Account
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Customers do not require accounts. Digital receipts are accessed anonymously via QR tokens.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
