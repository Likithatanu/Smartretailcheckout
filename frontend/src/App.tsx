import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  supabase, 
  getCurrentRetailerProfile, 
  getStoreProducts, 
  getActiveRegisterSession,
  getProductByBarcode,
  registerStoreAndManager
} from './lib/supabase';
import { getBridgeHealth, getScaleReading } from './lib/bridgeApi';
import type { 
  Profile, 
  Product, 
  RegisterSession, 
  CartItem, 
  BridgeHealth, 
  ScaleStatus 
} from './types/database';

import { Navbar } from './components/Navbar';
import { LoginView, type AuthCallbackNotification } from './components/LoginView';
import { RegisterSessionModal } from './components/RegisterSessionModal';
import { ScaleIndicator } from './components/ScaleIndicator';
import { VisionCaptureModal } from './components/VisionCaptureModal';
import { UnifiedCart } from './components/UnifiedCart';
import { ScannerListener } from './components/ScannerListener';
import { AutomaticScaleVisionListener, type AutoVisionStatusInfo } from './components/AutomaticScaleVisionListener';
import { ProductCatalogModal } from './components/ProductCatalogModal';
import { AddProductModal } from './components/AddProductModal';
import { StockAdjustmentModal } from './components/StockAdjustmentModal';
import { ReceiptModal } from './components/ReceiptModal';
import { PublicReceiptView } from './components/PublicReceiptView';
import { OrdersHistoryModal } from './components/OrdersHistoryModal';

import { 
  Camera, 
  Barcode, 
  PlusCircle, 
  Package, 
  AlertCircle, 
  RefreshCw,
  Copy,
  Check,
  Search,
  Wheat,
  Clock,
  TrendingDown,
  Sparkles,
  X,
  CheckCircle2,
  Store,
  Plus
} from 'lucide-react';

export const App: React.FC = () => {
  // 1. Check for Public QR Receipt Token in URL (?receipt=<uuid>)
  const urlParams = new URLSearchParams(window.location.search);
  const receiptTokenParam = urlParams.get('receipt');

  if (receiptTokenParam) {
    return (
      <PublicReceiptView
        receiptToken={receiptTokenParam}
        onBackToPos={() => {
          window.location.href = window.location.pathname;
        }}
      />
    );
  }

  // 2. Retailer Session & POS State
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeSession, setActiveSession] = useState<RegisterSession | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [loadingAuth, setLoadingAuth] = useState(true);

  // Hardware Status State
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [scaleStatus, setScaleStatus] = useState<ScaleStatus | null>(null);

  // Modal Visibility State
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [isVisionModalOpen, setIsVisionModalOpen] = useState(false);
  const [isCatalogModalOpen, setIsCatalogModalOpen] = useState(false);
  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [prefillModelClass, setPrefillModelClass] = useState<string | null>(null);
  const [isStockModalOpen, setIsStockModalOpen] = useState(false);
  const [selectedStockProduct, setSelectedStockProduct] = useState<Product | null>(null);
  const [isOrdersModalOpen, setIsOrdersModalOpen] = useState(false);
  const [lastOrderResult, setLastOrderResult] = useState<any | null>(null);
  const [activeReceiptToken, setActiveReceiptToken] = useState<string | null>(null);
  const [copiedUserId, setCopiedUserId] = useState(false);

  // Manual barcode entry input
  const [manualBarcodeInput, setManualBarcodeInput] = useState('');
  const [quickCatalogSearch, setQuickCatalogSearch] = useState('');

  // Barcode toast notification
  const [barcodeNotification, setBarcodeNotification] = useState<{
    barcode: string;
    message: string;
  } | null>(null);

  // Automatic Scale Vision status & operator alert
  const [autoVisionStatus, setAutoVisionStatus] = useState<AutoVisionStatusInfo | null>(null);

  // Email confirmation & auth callback recovery state
  const [authCallbackNotification, setAuthCallbackNotification] = useState<AuthCallbackNotification | null>(null);
  const authCallbackHandledRef = useRef(false);

  // Pending store self-registration state
  const [showSelfRegisterForm, setShowSelfRegisterForm] = useState(false);
  const [setupStoreName, setSetupStoreName] = useState('');
  const [setupStoreCode, setSetupStoreCode] = useState('');
  const [setupStoreAddress, setSetupStoreAddress] = useState('');
  const [setupTaxRate, setSetupTaxRate] = useState('0.00');
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Safely cleans sensitive authentication parameters and hash from browser URL without stripping unrelated params (e.g. ?receipt=...)
  const cleanAuthUrlParams = useCallback(() => {
    try {
      const searchParams = new URLSearchParams(window.location.search);
      let paramsChanged = false;
      ['error', 'error_code', 'error_description', 'code', 'type'].forEach((key) => {
        if (searchParams.has(key)) {
          searchParams.delete(key);
          paramsChanged = true;
        }
      });

      const hasHash = window.location.hash.length > 0;
      if (paramsChanged || hasHash) {
        const newSearch = searchParams.toString();
        const cleanUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch (err) {
      console.error('Failed to clean auth URL parameters:', err);
    }
  }, []);

  // Coordinated Supabase Auth initialization and PKCE / confirmation callback handling
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const hashString = window.location.hash.startsWith('#')
      ? window.location.hash.substring(1)
      : window.location.hash;
    const hashParams = new URLSearchParams(hashString);

    const authError = searchParams.get('error') || hashParams.get('error');
    const authErrorCode = searchParams.get('error_code') || hashParams.get('error_code');
    const authErrorDesc = searchParams.get('error_description') || hashParams.get('error_description');
    const hasCode = searchParams.has('code');
    const hasHashTokens = hashParams.has('access_token');
    const hasIncomingCredential = Boolean(hasCode || hasHashTokens);
    const hasAuthCallback = Boolean(authError || authErrorCode || hasIncomingCredential || searchParams.has('type') || hashParams.has('type'));

    // 1. Immediate error callback handling (e.g. #error=access_denied&error_code=otp_expired)
    // When Supabase reports an explicit error in callback, no PKCE code exchange is expected.
    if (!authCallbackHandledRef.current && (authError || authErrorCode)) {
      authCallbackHandledRef.current = true;

      if (authErrorCode === 'otp_expired' || (authErrorDesc && authErrorDesc.toLowerCase().includes('expired'))) {
        setAuthCallbackNotification({
          type: 'warning',
          message: 'Confirmation link has expired.',
          detail: 'The verification link has expired. Enter your retailer email below and click "Resend Confirmation Link" to receive a fresh verification link.',
        });
      } else {
        setAuthCallbackNotification({
          type: 'error',
          message: 'Email confirmation failed.',
          detail: authErrorDesc ? decodeURIComponent(authErrorDesc.replace(/\+/g, ' ')) : 'Unable to complete verification with the provided link. Please request a new confirmation link.',
        });
      }

      // Safe to clean error parameters now that error notification is recorded
      cleanAuthUrlParams();
    }

    // 2. Coordinate with Supabase Auth initialization and PKCE code exchange
    // CRITICAL: We preserve the `code` parameter in the URL until getSession() / exchangeCodeForSession completes!
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      const user = session?.user ?? null;
      setSessionUser(user);
      setLoadingAuth(false);

      if (!authCallbackHandledRef.current && hasAuthCallback) {
        authCallbackHandledRef.current = true;

        if (user && hasIncomingCredential) {
          // Verify actual email confirmation status from the authenticated Supabase user record
          const isEmailConfirmed = Boolean(user.email_confirmed_at || (user as any).confirmed_at);
          if (isEmailConfirmed) {
            setAuthCallbackNotification({
              type: 'success',
              message: 'Email verified successfully!',
              detail: 'Your email address is confirmed. You can now access your retailer terminal.',
              email: user.email,
            });
          } else {
            setAuthCallbackNotification({
              type: 'warning',
              message: 'Email verification pending.',
              detail: 'Your account session was opened, but email verification is not marked as completed in Supabase.',
              email: user.email,
            });
          }
        } else if (hasIncomingCredential) {
          // A code or token was present in the callback, but Supabase failed to establish a valid session
          setAuthCallbackNotification({
            type: 'error',
            message: 'Verification link invalid or expired.',
            detail: error?.message || 'The verification link could not be validated. Please request a new confirmation link.',
          });
        }
        // If ?type=signup was present without an incoming credential,
        // we intentionally do NOT show a confirmation notification.

        // Clean auth parameters from URL now that Supabase exchange / session recovery is complete
        cleanAuthUrlParams();
      }
    }).catch((err) => {
      console.error('Auth session initialization failed:', err);
      setLoadingAuth(false);
      if (!authCallbackHandledRef.current && hasIncomingCredential) {
        authCallbackHandledRef.current = true;
        setAuthCallbackNotification({
          type: 'error',
          message: 'Authentication service unavailable.',
          detail: 'Could not complete verification due to a connection issue. Please try again.',
        });
        cleanAuthUrlParams();
      }
    });

    // 3. Listen for ongoing auth state changes (e.g. PKCE exchange completion or sign out)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      setSessionUser(user);
      setLoadingAuth(false);

      if (!authCallbackHandledRef.current && event === 'SIGNED_IN' && user && hasIncomingCredential) {
        authCallbackHandledRef.current = true;
        const isEmailConfirmed = Boolean(user.email_confirmed_at || (user as any).confirmed_at);
        if (isEmailConfirmed) {
          setAuthCallbackNotification({
            type: 'success',
            message: 'Email verified successfully!',
            detail: 'Your email address is confirmed.',
            email: user.email,
          });
        }
        cleanAuthUrlParams();
      }
    });

    return () => subscription.unsubscribe();
  }, [cleanAuthUrlParams]);

  // Fetch retailer profile and store data
  const loadRetailerData = useCallback(async () => {
    if (!sessionUser) return;
    try {
      const prof = await getCurrentRetailerProfile();
      setProfile(prof);

      if (prof?.store_id && prof?.is_active) {
        try {
          const storeProds = await getStoreProducts(prof.store_id);
          setProducts(storeProds);
        } catch (prodErr) {
          console.error('Failed to load store products:', prodErr);
        }

        try {
          const regSession = await getActiveRegisterSession(prof.store_id, prof.id);
          setActiveSession(regSession);
        } catch (sessErr) {
          console.error('Failed to load active register session:', sessErr);
        }
      }
    } catch (err) {
      console.error('Failed to load store profile data:', err);
    }
  }, [sessionUser]);

  useEffect(() => {
    if (sessionUser) {
      loadRetailerData();
      // Pre-populate store activation fields from metadata if available
      const meta = (sessionUser.user_metadata || {}) as Record<string, any>;
      if (meta.store_name) setSetupStoreName(meta.store_name);
      if (meta.store_code) setSetupStoreCode(meta.store_code);
      if (meta.store_address) setSetupStoreAddress(meta.store_address);
      if (meta.default_tax_rate !== undefined) setSetupTaxRate(String(meta.default_tax_rate));
      if (meta.store_name || meta.store_code) setShowSelfRegisterForm(true);
    } else {
      setProfile(null);
      setProducts([]);
      setActiveSession(null);
      setCartItems([]);
      setShowSelfRegisterForm(false);
    }
  }, [sessionUser, loadRetailerData]);

  // Poll hardware bridge health and scale readings
  useEffect(() => {
    let mounted = true;

    const pollHardware = async () => {
      const [health, scale] = await Promise.all([
        getBridgeHealth(),
        getScaleReading(),
      ]);
      if (mounted) {
        setBridgeHealth(health);
        setScaleStatus(scale);
      }
    };

    pollHardware();
    const interval = setInterval(pollHardware, 2000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Handle adding an item to the unified cart (consolidates if already present)
  const handleAddToCart = (newItem: CartItem) => {
    setCartItems((prevItems) => {
      const existingIdx = prevItems.findIndex((it) => it.product.id === newItem.product.id);
      if (existingIdx >= 0) {
        const existing = prevItems[existingIdx];
        const updatedQty = Number((existing.quantity_or_weight + newItem.quantity_or_weight).toFixed(3));
        const unitPrice = existing.product.price_per_unit;
        const taxRate = existing.product.tax_rate_percent;

        const baseSubtotal = Number((unitPrice * updatedQty).toFixed(2));
        const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
        const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));

        const updated = [...prevItems];
        updated[existingIdx] = {
          ...existing,
          quantity_or_weight: updatedQty,
          base_subtotal: baseSubtotal,
          tax_amount: taxAmount,
          item_total: itemTotal,
        };
        return updated;
      }
      return [...prevItems, newItem];
    });
  };

  // Update item quantity
  const handleUpdateCartItemQty = (productId: string, newQty: number) => {
    if (newQty <= 0) {
      handleRemoveCartItem(productId);
      return;
    }
    setCartItems((prev) =>
      prev.map((item) => {
        if (item.product.id === productId) {
          const qty = Number(newQty.toFixed(3));
          const unitPrice = item.product.price_per_unit;
          const taxRate = item.product.tax_rate_percent;
          const baseSubtotal = Number((unitPrice * qty).toFixed(2));
          const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
          const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));
          return {
            ...item,
            quantity_or_weight: qty,
            base_subtotal: baseSubtotal,
            tax_amount: taxAmount,
            item_total: itemTotal,
          };
        }
        return item;
      })
    );
  };

  // Remove item from cart
  const handleRemoveCartItem = (productId: string) => {
    setCartItems((prev) => prev.filter((it) => it.product.id !== productId));
  };

  // Barcode scanned but not found in catalog
  const handleBarcodeNotFound = (scannedBarcode: string) => {
    setBarcodeNotification({
      barcode: scannedBarcode,
      message: `Barcode "${scannedBarcode}" not found in this store's catalog.`,
    });
  };

  // Manual barcode lookup form submission
  const handleManualBarcodeLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualBarcodeInput.trim() || !profile?.store_id) return;
    try {
      const p = await getProductByBarcode(profile.store_id, manualBarcodeInput.trim());
      if (p) {
        const qty = 1;
        const unitPrice = p.price_per_unit;
        const taxRate = p.tax_rate_percent;
        const baseSubtotal = Number((unitPrice * qty).toFixed(2));
        const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
        const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));

        handleAddToCart({
          product: p,
          quantity_or_weight: qty,
          base_subtotal: baseSubtotal,
          tax_amount: taxAmount,
          item_total: itemTotal,
          detection_source: 'manual',
        });
        setManualBarcodeInput('');
      } else {
        handleBarcodeNotFound(manualBarcodeInput.trim());
        setManualBarcodeInput('');
      }
    } catch (err: any) {
      console.error('Manual barcode lookup error:', err);
    }
  };

  // Logout handler
  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSessionUser(null);
  };

  // Complete store setup post-confirmation
  const handleCompleteStoreSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupStoreName.trim()) {
      setSetupError('Please enter a store name.');
      return;
    }
    const cleanCode = setupStoreCode.trim().toUpperCase();
    if (cleanCode.length < 3) {
      setSetupError('Store code must be at least 3 characters.');
      return;
    }
    setSetupLoading(true);
    setSetupError(null);
    try {
      await registerStoreAndManager({
        storeName: setupStoreName.trim(),
        storeCode: cleanCode,
        defaultTaxRate: parseFloat(setupTaxRate) || 0.00,
        storeAddress: setupStoreAddress.trim() || undefined,
        fullName: sessionUser?.user_metadata?.full_name || undefined,
      });
      await loadRetailerData();
    } catch (err: any) {
      console.error('Store activation error:', err);
      const msg = err.message || '';
      if (msg.includes('STORE_CODE_EXISTS') || msg.includes('duplicate key value') || msg.includes('uq_store_code')) {
        setSetupError(`Store code "${cleanCode}" is already in use by another store. Please choose a different code.`);
      } else {
        setSetupError(msg || 'Failed to activate store. Please try again.');
      }
    } finally {
      setSetupLoading(false);
    }
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-600 mb-2" />
        <span className="text-xs text-slate-500 font-medium">Connecting to Supabase...</span>
      </div>
    );
  }

  // Not signed in: render Retailer Login View
  if (!sessionUser) {
    return (
      <LoginView
        onLoginSuccess={() => loadRetailerData()}
        callbackNotification={authCallbackNotification}
        onClearCallbackNotification={() => setAuthCallbackNotification(null)}
      />
    );
  }

  // If customer clicked view receipt from receipt modal
  if (activeReceiptToken) {
    return (
      <PublicReceiptView
        receiptToken={activeReceiptToken}
        onBackToPos={() => setActiveReceiptToken(null)}
      />
    );
  }

  // Authenticated, but profile is inactive (deactivated account)
  if (profile && !profile.is_active) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 text-center">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl p-7 shadow-sm">
          <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 mb-4 inline-flex">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">Account Deactivated</h2>
          <p className="text-xs text-slate-500 mt-2 mb-5">
            Signed in as <span className="font-mono text-indigo-600 font-semibold">{sessionUser.email}</span>. Your retailer profile has been deactivated by your store administrator.
          </p>
          <div className="p-3.5 bg-rose-50/60 rounded-2xl text-left text-xs text-rose-800 mb-6 border border-rose-200">
            Store access is suspended. Please contact your store administrator to reactivate your profile.
          </div>
          <button
            onClick={handleLogout}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white transition-colors shadow-xs"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // Authenticated, but no linked store profile in public.profiles
  if (!profile) {
    const handleCopyId = () => {
      if (sessionUser?.id) {
        navigator.clipboard.writeText(sessionUser.id);
        setCopiedUserId(true);
        setTimeout(() => setCopiedUserId(false), 2000);
      }
    };

    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 text-center">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl p-7 shadow-sm">
          {/* Email Confirmation Notification Banner */}
          {authCallbackNotification && (
            <div
              className={`mb-5 p-3.5 rounded-2xl border text-xs text-left flex items-start justify-between space-x-2.5 ${
                authCallbackNotification.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : authCallbackNotification.type === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              <div className="flex items-start space-x-2 flex-1">
                {authCallbackNotification.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${authCallbackNotification.type === 'warning' ? 'text-amber-600' : 'text-rose-600'}`} />
                )}
                <div>
                  <div className="font-semibold">{authCallbackNotification.message}</div>
                  {authCallbackNotification.detail && (
                    <div className="text-[11px] opacity-90 mt-0.5 leading-relaxed">{authCallbackNotification.detail}</div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAuthCallbackNotification(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-black/5 transition-colors"
                aria-label="Dismiss message"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 mb-4 inline-flex">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">Pending Store Activation</h2>
          <p className="text-xs text-slate-500 mt-2 mb-4">
            Signed in as <span className="font-mono text-indigo-600 font-semibold">{sessionUser.email}</span>. This account does not yet have an active store profile linked in Supabase.
          </p>

          {showSelfRegisterForm ? (
            <form onSubmit={handleCompleteStoreSetup} className="text-left space-y-3 mb-5 p-4 bg-slate-50 rounded-2xl border border-slate-200">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                <span className="text-xs font-bold text-slate-800">Complete Store Setup</span>
                <button
                  type="button"
                  onClick={() => setShowSelfRegisterForm(false)}
                  className="text-[11px] text-slate-400 hover:text-slate-600"
                >
                  Cancel
                </button>
              </div>

              {setupError && (
                <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-1.5">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
                  <span>{setupError}</span>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Store Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={setupStoreName}
                  onChange={(e) => {
                    setSetupStoreName(e.target.value);
                    if (!setupStoreCode) {
                      const slug = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30);
                      setSetupStoreCode(slug ? `${slug}_001` : '');
                    }
                  }}
                  placeholder="e.g. Basaweshwara mart"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Store Code (Unique) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={setupStoreCode}
                  onChange={(e) => setSetupStoreCode(e.target.value.toUpperCase())}
                  placeholder="e.g. BASAWESHWARA_MART_001"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono uppercase text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Store Address <span className="text-slate-400 font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={setupStoreAddress}
                  onChange={(e) => setSetupStoreAddress(e.target.value)}
                  placeholder="e.g. Main Market, Bangalore"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Default Tax Rate % <span className="text-slate-400 font-normal">(Default 0.00)</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={setupTaxRate}
                  onChange={(e) => setSetupTaxRate(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <button
                type="submit"
                disabled={setupLoading}
                className="w-full mt-2 py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
              >
                {setupLoading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Activating Store...</span>
                  </>
                ) : (
                  <>
                    <Store className="w-3.5 h-3.5" />
                    <span>Activate Store & Access POS</span>
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-4 mb-5">
              <button
                type="button"
                onClick={() => setShowSelfRegisterForm(true)}
                className="w-full py-3 px-4 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center justify-center space-x-2 transition-all shadow-xs"
              >
                <Plus className="w-4 h-4" />
                <span>Complete Store Setup & Activate</span>
              </button>

              <div className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">
                — OR PROVIDE USER ID TO ADMINISTRATOR —
              </div>

              <div className="p-3.5 bg-slate-50 rounded-2xl text-left text-xs font-mono text-slate-600 border border-slate-200">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>SUPABASE AUTH USER ID</span>
                  <button
                    type="button"
                    onClick={handleCopyId}
                    className="text-indigo-600 hover:text-indigo-700 flex items-center space-x-1 font-sans font-semibold transition-colors"
                  >
                    {copiedUserId ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span className="text-emerald-600">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="text-slate-900 break-all select-all font-mono text-[12px] font-semibold">{sessionUser.id}</div>
              </div>
            </div>
          )}

          <div className="flex space-x-2.5">
            <button
              onClick={() => loadRetailerData()}
              className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-700 transition-colors shadow-xs"
            >
              Retry Profile Check
            </button>
            <button
              onClick={handleLogout}
              className="py-2.5 px-4 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors shadow-xs"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Calculate dynamic dashboard stats
  const lowStockCount = products.filter(p => p.stock_quantity <= p.min_stock_threshold).length;
  const filteredQuickProducts = products.filter(p => 
    !quickCatalogSearch || 
    p.name.toLowerCase().includes(quickCatalogSearch.toLowerCase()) ||
    (p.barcode && p.barcode.includes(quickCatalogSearch)) ||
    (p.model_class && p.model_class.toLowerCase().includes(quickCatalogSearch.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Global Hardware Listeners: USB Barcode Scanner & Automatic Scale Vision */}
      {profile?.store_id && (
        <>
          <ScannerListener
            storeId={profile.store_id}
            onAddToCart={handleAddToCart}
            onBarcodeNotFound={handleBarcodeNotFound}
          />
          {/* Background auto-capture disabled per user request (manual AI Camera Recognition used instead) */}
          <AutomaticScaleVisionListener
            storeId={profile.store_id}
            enabled={false}
            onAddToCart={handleAddToCart}
            onStatusChange={setAutoVisionStatus}
          />
        </>
      )}

      {/* Top POS Navbar */}
      <Navbar
        profile={profile}
        activeSession={activeSession}
        bridgeHealth={bridgeHealth}
        scaleStatus={scaleStatus}
        onOpenSessionModal={() => setIsSessionModalOpen(true)}
        onOpenCatalogModal={() => setIsCatalogModalOpen(true)}
        onOpenOrdersModal={() => setIsOrdersModalOpen(true)}
        onLogout={handleLogout}
      />

      {/* Main Terminal Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 space-y-4">
        {/* Dynamic Metric Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
              <Package className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400">Store Catalog</div>
              <div className="text-base font-bold text-slate-900">{products.length} Products</div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs flex items-center space-x-3">
            <div className={`p-2 rounded-lg ${lowStockCount > 0 ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>
              <TrendingDown className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400">Low Stock Alert</div>
              <div className={`text-base font-bold ${lowStockCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                {lowStockCount} Items
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs flex items-center space-x-3">
            <div className={`p-2 rounded-lg ${activeSession ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400">Register Session</div>
              <div className="text-base font-bold text-slate-900 truncate">
                {activeSession ? activeSession.register_name : 'No Session'}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
              <span className="font-bold text-xs">%</span>
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400">Store Tax Rate</div>
              <div className="text-base font-bold text-slate-900">
                {profile.store?.default_tax_rate ?? 5.0}% GST
              </div>
            </div>
          </div>
        </div>

        {/* 2-Column POS Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left Column (Checkout Hardware & Action Workspace - 7 cols) */}
          <div className="lg:col-span-7 flex flex-col space-y-4">
            {/* Quick Hardware Actions Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* AI Vision Launch Card */}
              <button
                onClick={() => setIsVisionModalOpen(true)}
                className="p-4 rounded-2xl bg-white border border-slate-200 hover:border-indigo-300 shadow-xs hover:shadow-sm transition-all text-left group flex flex-col justify-between"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600 group-hover:scale-105 transition-transform">
                    <Camera className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-mono font-bold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-100">
                    ConvNeXt AI
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
                    AI Camera Recognition
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Weigh & classify Chana Dal, Masur Dal, or Rice
                  </p>
                </div>
              </button>

              {/* USB Barcode Scanner Card */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs text-left flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
                      <Barcode className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200">
                      Scanner Ready
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900">USB Barcode Scanner</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Point and scan physical barcode, or enter manual code:
                  </p>
                </div>

                <form onSubmit={handleManualBarcodeLookup} className="mt-2.5 flex items-center space-x-1.5">
                  <input
                    type="text"
                    value={manualBarcodeInput}
                    onChange={(e) => setManualBarcodeInput(e.target.value)}
                    placeholder="Enter barcode..."
                    className="flex-1 py-1 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="submit"
                    className="py-1 px-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-semibold transition-colors"
                  >
                    Lookup
                  </button>
                </form>
              </div>
            </div>

            {/* Unknown Barcode Notification Toast */}
            {barcodeNotification && (
              <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                  <div>
                    <span className="font-semibold block">{barcodeNotification.message}</span>
                    <span className="text-[10px] text-amber-700 font-mono">Barcode: {barcodeNotification.barcode}</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setBarcodeNotification(null);
                    setIsAddProductModalOpen(true);
                  }}
                  className="py-1.5 px-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex-shrink-0 transition-colors shadow-xs"
                >
                  Register Product
                </button>
              </div>
            )}

            {/* Automatic AI Vision Operator Notification */}
            {autoVisionStatus && autoVisionStatus.type !== 'idle' && (
              <div
                className={`p-3.5 rounded-2xl border text-xs flex items-center justify-between gap-3 shadow-xs transition-all ${
                  autoVisionStatus.type === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : autoVisionStatus.type === 'error' || autoVisionStatus.type === 'warning'
                    ? 'bg-rose-50 border-rose-200 text-rose-800'
                    : 'bg-indigo-50 border-indigo-200 text-indigo-800'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  {autoVisionStatus.type === 'success' ? (
                    <Check className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  ) : autoVisionStatus.type === 'error' || autoVisionStatus.type === 'warning' ? (
                    <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0" />
                  ) : (
                    <Sparkles className="w-5 h-5 text-indigo-600 flex-shrink-0 animate-pulse" />
                  )}
                  <div>
                    <span className="font-semibold block">{autoVisionStatus.message}</span>
                    {autoVisionStatus.detail && (
                      <span className="text-[11px] opacity-80">{autoVisionStatus.detail}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setAutoVisionStatus(null)}
                  className="p-1 rounded-lg hover:bg-black/5 text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label="Dismiss notification"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Live Scale Widget */}
            <ScaleIndicator autoVisionStatus={autoVisionStatus} />

            {/* Quick Store Catalog Picker */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs flex-1 flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center space-x-2">
                  <Package className="w-4 h-4 text-indigo-600" />
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Store Catalog (Quick Add)
                  </h3>
                </div>
                <div className="flex items-center space-x-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={quickCatalogSearch}
                      onChange={(e) => setQuickCatalogSearch(e.target.value)}
                      placeholder="Filter items..."
                      className="pl-8 pr-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-32 sm:w-40"
                    />
                  </div>
                  <button
                    onClick={() => setIsCatalogModalOpen(true)}
                    className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold"
                  >
                    View All ({products.length})
                  </button>
                </div>
              </div>

              {filteredQuickProducts.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-400 space-y-2 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  <Package className="w-8 h-8 text-slate-300" />
                  <span className="text-xs font-semibold text-slate-700">No matching products</span>
                  <button
                    onClick={() => setIsAddProductModalOpen(true)}
                    className="py-1.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs transition-colors shadow-xs"
                  >
                    Add Product
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 overflow-y-auto max-h-[280px] p-1">
                  {filteredQuickProducts.map((p) => {
                    const isLoose = p.product_type === 'loose';
                    const isLow = p.stock_quantity <= p.min_stock_threshold;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          if (isLoose) {
                            setIsVisionModalOpen(true);
                          } else {
                            const qty = 1;
                            const unitPrice = p.price_per_unit;
                            const taxRate = p.tax_rate_percent;
                            const baseSubtotal = Number((unitPrice * qty).toFixed(2));
                            const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
                            const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));
                            handleAddToCart({
                              product: p,
                              quantity_or_weight: qty,
                              base_subtotal: baseSubtotal,
                              tax_amount: taxAmount,
                              item_total: itemTotal,
                              detection_source: 'manual',
                            });
                          }
                        }}
                        className="p-2.5 rounded-xl bg-slate-50/70 border border-slate-200 hover:bg-white hover:border-indigo-300 transition-all text-left flex flex-col justify-between group shadow-2xs hover:shadow-xs"
                      >
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span
                              className={`text-[8px] uppercase font-bold px-1.5 py-0.5 rounded ${
                                isLoose
                                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                  : 'bg-slate-100 text-slate-700 border border-slate-200'
                              }`}
                            >
                              {isLoose ? 'Loose' : 'Packaged'}
                            </span>
                            <span className={`text-[10px] font-mono ${isLow ? 'text-amber-600 font-bold' : 'text-slate-500'}`}>
                              Stock: {p.stock_quantity.toFixed(1)}
                            </span>
                          </div>
                          <div className="text-xs font-semibold text-slate-800 group-hover:text-indigo-600 line-clamp-1">
                            {p.name}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs font-mono font-bold text-indigo-600">
                          <span>₹{p.price_per_unit.toFixed(2)}</span>
                          <span className="text-[10px] font-normal text-slate-500">/{p.unit}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Column (Unified Shopping Cart & Atomic Checkout - 5 cols) */}
          <div className="lg:col-span-5 h-[calc(100vh-8.5rem)] min-h-[500px]">
            <UnifiedCart
              cartItems={cartItems}
              activeSession={activeSession}
              onUpdateCartItem={handleUpdateCartItemQty}
              onRemoveCartItem={handleRemoveCartItem}
              onClearCart={() => setCartItems([])}
              onCheckoutComplete={(result) => setLastOrderResult(result)}
            />
          </div>
        </div>
      </main>

      {/* Modals */}
      {isSessionModalOpen && (
        <RegisterSessionModal
          activeSession={activeSession}
          onClose={() => setIsSessionModalOpen(false)}
          onSessionUpdated={(s) => setActiveSession(s)}
        />
      )}

      {isVisionModalOpen && profile?.store_id && (
        <VisionCaptureModal
          storeId={profile.store_id}
          onClose={() => setIsVisionModalOpen(false)}
          onAddToCart={handleAddToCart}
          onOpenAddProductModal={(modelCls) => {
            setPrefillModelClass(modelCls);
            setIsAddProductModalOpen(true);
          }}
        />
      )}

      {isCatalogModalOpen && (
        <ProductCatalogModal
          storeId={profile.store_id}
          products={products}
          onClose={() => setIsCatalogModalOpen(false)}
          onOpenAddModal={() => {
            setProductToEdit(null);
            setIsAddProductModalOpen(true);
          }}
          onOpenEditModal={(prod) => {
            setProductToEdit(prod);
            setIsAddProductModalOpen(true);
          }}
          onOpenStockModal={(prod) => {
            setSelectedStockProduct(prod || null);
            setIsStockModalOpen(true);
          }}
          onRefreshProducts={loadRetailerData}
        />
      )}

      {isAddProductModalOpen && profile?.store_id && (
        <AddProductModal
          storeId={profile.store_id}
          prefillModelClass={prefillModelClass}
          productToEdit={productToEdit}
          onClose={() => {
            setIsAddProductModalOpen(false);
            setProductToEdit(null);
            setPrefillModelClass(null);
          }}
          onProductSaved={(savedProd) => {
            setProducts((prev) => {
              const idx = prev.findIndex((p) => p.id === savedProd.id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = savedProd;
                return updated;
              }
              return [savedProd, ...prev];
            });
            loadRetailerData();
          }}
        />
      )}

      {isStockModalOpen && (
        <StockAdjustmentModal
          products={products}
          selectedProduct={selectedStockProduct}
          onClose={() => {
            setIsStockModalOpen(false);
            setSelectedStockProduct(null);
          }}
          onStockAdjusted={() => loadRetailerData()}
        />
      )}

      {isOrdersModalOpen && profile?.store_id && (
        <OrdersHistoryModal
          storeId={profile.store_id}
          onClose={() => setIsOrdersModalOpen(false)}
          onViewReceipt={(token) => {
            setIsOrdersModalOpen(false);
            setActiveReceiptToken(token);
          }}
        />
      )}

      {lastOrderResult && (
        <ReceiptModal
          orderResult={lastOrderResult}
          onClose={() => setLastOrderResult(null)}
          onViewReceipt={(token) => {
            setLastOrderResult(null);
            setActiveReceiptToken(token);
          }}
        />
      )}
    </div>
  );
};
