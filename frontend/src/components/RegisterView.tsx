import React, { useState } from 'react';
import { 
  Store, 
  Lock, 
  Mail, 
  User, 
  UserPlus, 
  AlertCircle, 
  CheckCircle2, 
  ArrowRight, 
  Eye, 
  EyeOff, 
  RefreshCw, 
  ShieldCheck, 
  HelpCircle,
  Check,
  X,
  MapPin,
  Percent,
  Hash
} from 'lucide-react';
import { registerRetailer, registerStoreAndManager } from '../lib/supabase';

interface RegisterViewProps {
  onSwitchToLogin: () => void;
  onRegisterSuccess?: () => void;
}

export const RegisterView: React.FC<RegisterViewProps> = ({
  onSwitchToLogin,
  onRegisterSuccess,
}) => {
  // Account fields
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Store fields
  const [storeName, setStoreName] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [defaultTaxRate, setDefaultTaxRate] = useState('0.00');

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [touched, setTouched] = useState({
    fullName: false,
    email: false,
    password: false,
    confirmPassword: false,
    storeName: false,
    storeCode: false,
  });

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [successInfo, setSuccessInfo] = useState<{
    email: string;
    storeName: string;
    hasSession: boolean;
  } | null>(null);

  const passwordCriteria = {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasNumber: /[0-9]/.test(password),
    hasSpecial: /[!@#$%^&*(),.?":{}|<>]/.test(password),
  };

  const isPasswordValid = Object.values(passwordCriteria).every(Boolean);
  const isEmailValid = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim());
  const isFullNameValid = fullName.trim().length >= 2;
  const isConfirmMatch = password === confirmPassword && confirmPassword.length > 0;

  const isStoreNameValid = storeName.trim().length >= 2;
  const cleanStoreCode = storeCode.trim().toUpperCase();
  const isStoreCodeValid = cleanStoreCode.length >= 3 && /^[A-Z0-9_-]+$/.test(cleanStoreCode);
  const parsedTax = parseFloat(defaultTaxRate);
  const isTaxValid = !isNaN(parsedTax) && parsedTax >= 0 && parsedTax <= 100;

  const isFormValid = 
    isFullNameValid && 
    isEmailValid && 
    isPasswordValid && 
    isConfirmMatch && 
    isStoreNameValid && 
    isStoreCodeValid && 
    isTaxValid;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!isFullNameValid) {
      setErrorMsg('Please enter your full name (minimum 2 characters).');
      return;
    }
    if (!isEmailValid) {
      setErrorMsg('Please enter a valid retailer email address.');
      return;
    }
    if (!isPasswordValid) {
      setErrorMsg('Password does not satisfy the security requirements.');
      return;
    }
    if (!isConfirmMatch) {
      setErrorMsg('Passwords do not match. Please re-enter your password.');
      return;
    }
    if (!isStoreNameValid) {
      setErrorMsg('Please enter a valid store name (minimum 2 characters).');
      return;
    }
    if (!isStoreCodeValid) {
      setErrorMsg('Store code must be at least 3 characters and contain only uppercase letters, numbers, hyphens, or underscores.');
      return;
    }
    if (!isTaxValid) {
      setErrorMsg('Default tax rate must be a valid number between 0.00 and 100.00 percent.');
      return;
    }

    setLoading(true);

    try {
      // Step 1: Register credentials through Supabase Auth, securely attaching store metadata to raw_user_meta_data
      const data = await registerRetailer({
        email: email.trim(),
        password: password,
        fullName: fullName.trim(),
        storeMetadata: {
          store_name: storeName.trim(),
          store_code: cleanStoreCode,
          store_address: storeAddress.trim() || undefined,
          default_tax_rate: parsedTax,
        },
      });

      if (data.user && data.user.identities && data.user.identities.length === 0) {
        throw new Error('An account with this email address already exists. Please sign in instead.');
      }

      // Step 2: If session is established immediately (e.g. email confirmation disabled / auto-confirm)
      if (data.session) {
        // Provision store and profile securely via backend RPC
        await registerStoreAndManager({
          storeName: storeName.trim(),
          storeCode: cleanStoreCode,
          defaultTaxRate: parsedTax,
          storeAddress: storeAddress.trim() || undefined,
          fullName: fullName.trim(),
        });

        setSuccessInfo({
          email: email.trim(),
          storeName: storeName.trim(),
          hasSession: true,
        });

        if (onRegisterSuccess) {
          onRegisterSuccess();
        }
      } else {
        // Step 2b: Email confirmation is required by Supabase Auth
        // Store and profile cannot be provisioned anonymously; user must confirm email first.
        setSuccessInfo({
          email: email.trim(),
          storeName: storeName.trim(),
          hasSession: false,
        });
      }
    } catch (err: any) {
      console.error('Registration error:', err);
      const msg = err.message || '';
      if (msg.includes('STORE_CODE_EXISTS') || msg.includes('duplicate key value') || msg.includes('uq_store_code')) {
        setErrorMsg(`Store code "${cleanStoreCode}" is already in use by another store. Please choose a different unique code.`);
      } else if (msg.includes('PROFILE_EXISTS')) {
        setErrorMsg('An active retailer profile is already linked to this account. Please sign in directly.');
      } else {
        setErrorMsg(msg || 'Failed to complete registration. Please check your network and credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Render Registration Success Screen
  if (successInfo) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-7 shadow-sm text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 mb-4 shadow-sm">
            <CheckCircle2 className="w-8 h-8" />
          </div>

          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Retailer Registration Initiated</h2>
          <p className="text-xs text-slate-500 mt-2 mb-5">
            Account for <span className="font-mono text-indigo-600 font-semibold">{successInfo.email}</span> registered for store <span className="font-semibold text-slate-900">{successInfo.storeName}</span>.
          </p>

          <div className="bg-slate-50 rounded-xl p-4 text-left border border-slate-200 space-y-3 mb-6">
            <div className="flex items-start space-x-2.5">
              <div className="p-1 rounded-full bg-emerald-100 text-emerald-700 mt-0.5">
                <Check className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs text-slate-700">
                <span className="font-semibold text-slate-900">1. Verification Status:</span>{' '}
                {successInfo.hasSession ? (
                  <span className="text-emerald-700 font-medium">Account pre-confirmed. Store and profile activated.</span>
                ) : (
                  <span>Please check your inbox to confirm your email. Once confirmed, sign in to finalize your store activation.</span>
                )}
              </div>
            </div>

            <div className="flex items-start space-x-2.5">
              <div className="p-1 rounded-full bg-indigo-100 text-indigo-700 mt-0.5">
                <Store className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs text-slate-700">
                <span className="font-semibold text-slate-900">2. Store Isolation:</span>{' '}
                Your catalog, inventory, and order receipts are securely isolated to your store identifier.
              </div>
            </div>

            <div className="flex items-start space-x-2.5">
              <div className="p-1 rounded-full bg-amber-100 text-amber-700 mt-0.5">
                <ShieldCheck className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs text-slate-700">
                <span className="font-semibold text-slate-900">3. Role Assignment:</span>{' '}
                Your account is assigned the <span className="font-mono text-[11px] font-semibold text-amber-800">'store_manager'</span> role over your registered store.
              </div>
            </div>
          </div>

          {successInfo.hasSession ? (
            <button
              onClick={() => {
                if (onRegisterSuccess) {
                  onRegisterSuccess();
                } else {
                  onSwitchToLogin();
                }
              }}
              className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-sm flex items-center justify-center space-x-2 transition-all"
            >
              <span>Continue to Terminal</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onSwitchToLogin}
              className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-sm flex items-center justify-center space-x-2 transition-all"
            >
              <span>Return to Retailer Sign In</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-600 mb-3 shadow-sm">
            <Store className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">AI Smart Retail Checkout</h1>
          <p className="text-sm text-slate-500 mt-1">Retailer Self-Registration & Store Provisioning</p>
        </div>

        {/* Registration Card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
            <div className="flex items-center space-x-2 text-xs text-slate-700 font-medium">
              <UserPlus className="w-4 h-4 text-indigo-600" />
              <span>Create Retailer Account & Store</span>
            </div>
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold transition-colors"
            >
              Back to Sign In
            </button>
          </div>

          {errorMsg && (
            <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMsg}</div>
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-4">
            {/* Section 1: Retailer Credentials */}
            <div className="border-b border-slate-100 pb-3">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-3">
                1. Retailer Credentials
              </span>

              <div className="space-y-3">
                {/* Full Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Full Name <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <User className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={fullName}
                      onBlur={() => setTouched(t => ({ ...t, fullName: true }))}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="e.g. Ramesh Kumar"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                  </div>
                  {touched.fullName && !isFullNameValid && (
                    <p className="text-[11px] text-rose-600 mt-1">Please enter your full name (minimum 2 characters).</p>
                  )}
                </div>

                {/* Email Address */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Retailer Email <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Mail className="w-4 h-4" />
                    </div>
                    <input
                      type="email"
                      required
                      value={email}
                      onBlur={() => setTouched(t => ({ ...t, email: true }))}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="retailer@store.com"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                  </div>
                  {touched.email && !isEmailValid && (
                    <p className="text-[11px] text-rose-600 mt-1">Please enter a valid email address.</p>
                  )}
                </div>

                {/* Password */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Password <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onBlur={() => setTouched(t => ({ ...t, password: true }))}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full pl-10 pr-10 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
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

                  {password.length > 0 && (
                    <div className="mt-2 p-2 bg-slate-50 rounded-xl border border-slate-200 grid grid-cols-2 gap-1 text-[11px]">
                      <span className={`flex items-center space-x-1 ${passwordCriteria.minLength ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>
                        {passwordCriteria.minLength ? <Check className="w-3 h-3 text-emerald-600" /> : <X className="w-3 h-3" />}
                        <span>8+ characters</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${passwordCriteria.hasUpper ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>
                        {passwordCriteria.hasUpper ? <Check className="w-3 h-3 text-emerald-600" /> : <X className="w-3 h-3" />}
                        <span>Uppercase (A-Z)</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${passwordCriteria.hasLower ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>
                        {passwordCriteria.hasLower ? <Check className="w-3 h-3 text-emerald-600" /> : <X className="w-3 h-3" />}
                        <span>Lowercase (a-z)</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${passwordCriteria.hasNumber ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>
                        {passwordCriteria.hasNumber ? <Check className="w-3 h-3 text-emerald-600" /> : <X className="w-3 h-3" />}
                        <span>Number (0-9)</span>
                      </span>
                      <span className={`flex items-center space-x-1 col-span-2 ${passwordCriteria.hasSpecial ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>
                        {passwordCriteria.hasSpecial ? <Check className="w-3 h-3 text-emerald-600" /> : <X className="w-3 h-3" />}
                        <span>Special character (!@#$...)</span>
                      </span>
                    </div>
                  )}
                </div>

                {/* Confirm Password */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Confirm Password <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      required
                      value={confirmPassword}
                      onBlur={() => setTouched(t => ({ ...t, confirmPassword: true }))}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full pl-10 pr-10 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(v => !v)}
                      className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                      aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {touched.confirmPassword && !isConfirmMatch && confirmPassword.length > 0 && (
                    <p className="text-[11px] text-rose-600 mt-1">Passwords do not match.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Section 2: Store Details */}
            <div className="border-b border-slate-100 pb-3">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-3">
                2. Store Details
              </span>

              <div className="space-y-3">
                {/* Store Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Store Name <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Store className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={storeName}
                      onBlur={() => setTouched(t => ({ ...t, storeName: true }))}
                      onChange={(e) => {
                        setStoreName(e.target.value);
                        // Auto-populate store code slug if user hasn't typed one yet
                        if (!touched.storeCode) {
                          const slug = e.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, '_')
                            .replace(/_+/g, '_')
                            .slice(0, 30);
                          setStoreCode(slug ? `${slug}_001` : '');
                        }
                      }}
                      placeholder="e.g. Basaweshwara mart"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                  </div>
                  {touched.storeName && !isStoreNameValid && (
                    <p className="text-[11px] text-rose-600 mt-1">Please enter a valid store name (minimum 2 characters).</p>
                  )}
                </div>

                {/* Store Code */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Store Code (Unique Identifier) <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Hash className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={storeCode}
                      onBlur={() => setTouched(t => ({ ...t, storeCode: true }))}
                      onChange={(e) => setStoreCode(e.target.value.toUpperCase())}
                      placeholder="e.g. BASAWESHWARA_MART_001"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all uppercase"
                    />
                  </div>
                  {touched.storeCode && !isStoreCodeValid && (
                    <p className="text-[11px] text-rose-600 mt-1">Must be 3+ characters (uppercase letters, numbers, hyphens, underscores).</p>
                  )}
                </div>

                {/* Store Address */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Store Address <span className="text-slate-400 font-normal">(Optional)</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <MapPin className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      value={storeAddress}
                      onChange={(e) => setStoreAddress(e.target.value)}
                      placeholder="e.g. Main Market, Bangalore"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                  </div>
                </div>

                {/* Default Tax Rate */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Default Tax Rate % <span className="text-slate-400 font-normal">(Default 0.00)</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Percent className="w-4 h-4" />
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={defaultTaxRate}
                      onChange={(e) => setDefaultTaxRate(e.target.value)}
                      placeholder="0.00"
                      className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Role Notice */}
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-[11px] text-slate-600 flex items-start space-x-2">
              <HelpCircle className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
              <span>
                Registering creates a new isolated store and assigns your account as its <span className="text-slate-900 font-semibold">'store_manager'</span>. Role elevation to admin is strictly prohibited.
              </span>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || !isFormValid}
              className="w-full mt-2 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm shadow-sm flex items-center justify-center space-x-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Provisioning Account & Store...</span>
                </>
              ) : (
                <>
                  <span>Create Account & Register Store</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Switch back to Login */}
          <div className="mt-5 pt-4 border-t border-slate-100 text-center flex items-center justify-center space-x-1.5 text-xs text-slate-600">
            <span>Already have an account?</span>
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="text-indigo-600 hover:text-indigo-700 font-semibold transition-colors"
            >
              Sign In
            </button>
          </div>

          <div className="mt-3 text-center">
            <p className="text-[11px] text-slate-400">
              Customers do not require accounts. Receipts are accessed via anonymous QR tokens.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
