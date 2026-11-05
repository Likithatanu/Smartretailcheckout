import React, { useState } from 'react';
import { 
  ShoppingCart, 
  Trash2, 
  Plus, 
  Minus, 
  ArrowRight, 
  AlertCircle, 
  RefreshCw 
} from 'lucide-react';
import type { CartItem, RegisterSession } from '../types/database';
import { processCheckout } from '../lib/supabase';
import { playCheckoutSuccess, playErrorAlert } from '../lib/sound';

interface UnifiedCartProps {
  cartItems: CartItem[];
  activeSession: RegisterSession | null;
  onUpdateCartItem: (productId: string, newQty: number) => void;
  onRemoveCartItem: (productId: string) => void;
  onClearCart: () => void;
  onCheckoutComplete: (result: {
    order_id: string;
    order_number: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    receipt_token: string;
    items: CartItem[];
  }) => void;
}

export const UnifiedCart: React.FC<UnifiedCartProps> = ({
  cartItems,
  activeSession,
  onUpdateCartItem,
  onRemoveCartItem,
  onClearCart,
  onCheckoutComplete,
}) => {
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Calculate totals across cart
  const subtotal = Number(cartItems.reduce((acc, item) => acc + item.base_subtotal, 0).toFixed(2));
  const taxTotal = Number(cartItems.reduce((acc, item) => acc + item.tax_amount, 0).toFixed(2));
  const grandTotal = Number((subtotal + taxTotal).toFixed(2));
  const totalItemCount = cartItems.length;

  const handleExecuteCheckout = async () => {
    if (cartItems.length === 0) return;
    if (!activeSession) {
      alert('Cannot checkout: Please open an active register session first.');
      return;
    }

    setCheckingOut(true);
    setCheckoutError(null);

    try {
      const idempotencyKey = crypto.randomUUID();
      const result = await processCheckout(cartItems, activeSession.id, idempotencyKey);

      if (result.success) {
        playCheckoutSuccess();
        onCheckoutComplete({
          order_id: result.order_id,
          order_number: result.order_number,
          subtotal: result.subtotal,
          tax_amount: result.tax_amount,
          total_amount: result.total_amount,
          receipt_token: result.receipt_token,
          items: [...cartItems],
        });
        onClearCart();
      } else {
        throw new Error('Checkout response did not indicate success.');
      }
    } catch (err: any) {
      console.error('Checkout error:', err);
      playErrorAlert();
      setCheckoutError(err.message || 'Atomic database checkout failed.');
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl flex flex-col h-full shadow-xs overflow-hidden">
      {/* Cart Header */}
      <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-white">
        <div className="flex items-center space-x-2.5">
          <div className="p-2 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
            <ShoppingCart className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 flex items-center space-x-2">
              <span>Checkout Cart</span>
              <span className="text-xs font-mono font-medium bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full border border-slate-200">
                {totalItemCount} {totalItemCount === 1 ? 'item' : 'items'}
              </span>
            </h2>
            <p className="text-[11px] text-slate-500">AI Loose & Packaged Barcode Items</p>
          </div>
        </div>

        {cartItems.length > 0 && (
          <button
            onClick={onClearCart}
            disabled={checkingOut}
            className="text-xs text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors p-1.5 rounded-lg flex items-center space-x-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {checkoutError && (
        <div className="m-3 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
          <div className="flex-1 font-medium">{checkoutError}</div>
        </div>
      )}

      {/* Cart Item List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-[220px]">
        {cartItems.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400">
              <ShoppingCart className="w-6 h-6" />
            </div>
            <div className="text-xs font-semibold text-slate-700">Your cart is empty</div>
            <p className="text-[11px] text-slate-400 max-w-xs">
              Scan packaged goods with USB scanner or click "AI Camera" to recognize weighed loose grains.
            </p>
          </div>
        ) : (
          cartItems.map((item) => {
            const isLoose = item.product.product_type === 'loose';
            return (
              <div
                key={item.product.id}
                className="bg-slate-50/80 border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-3 hover:border-slate-300 transition-colors"
              >
                {/* Item Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold text-xs text-slate-900 truncate">
                      {item.product.name}
                    </span>
                    <span
                      className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${
                        isLoose
                          ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}
                    >
                      {isLoose ? 'Loose' : 'Packaged'}
                    </span>
                  </div>

                  <div className="text-[11px] text-slate-500 flex items-center space-x-2 mt-1">
                    <span>
                      ₹{item.product.price_per_unit.toFixed(2)} / {item.product.unit}
                    </span>
                    <span className="text-slate-300">•</span>
                    <span>Tax: {item.product.tax_rate_percent}% (₹{item.tax_amount.toFixed(2)})</span>
                  </div>
                </div>

                {/* Quantity Controls & Line Total */}
                <div className="flex items-center space-x-2.5">
                  {!isLoose ? (
                    <div className="flex items-center bg-white border border-slate-200 rounded-lg p-0.5 shadow-xs">
                      <button
                        onClick={() => onUpdateCartItem(item.product.id, item.quantity_or_weight - 1)}
                        className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 transition-colors"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="px-2 text-xs font-mono font-semibold text-slate-800">
                        {item.quantity_or_weight}
                      </span>
                      <button
                        onClick={() => onUpdateCartItem(item.product.id, item.quantity_or_weight + 1)}
                        className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <div className="text-right">
                      <div className="text-xs font-mono font-semibold text-indigo-600">
                        {item.quantity_or_weight.toFixed(3)} {item.product.unit}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {item.weight_grams ? `${item.weight_grams.toFixed(0)}g` : ''}
                      </div>
                    </div>
                  )}

                  {/* Line Total */}
                  <div className="text-right min-w-[65px]">
                    <div className="text-xs font-mono font-bold text-slate-900">
                      ₹{item.item_total.toFixed(2)}
                    </div>
                  </div>

                  {/* Delete Button */}
                  <button
                    onClick={() => onRemoveCartItem(item.product.id)}
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Cart Summary & Checkout */}
      <div className="p-4 bg-slate-50 border-t border-slate-200 space-y-3">
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between text-slate-500">
            <span>Base Subtotal</span>
            <span className="font-mono text-slate-800 font-semibold">₹{subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>Tax (GST)</span>
            <span className="font-mono text-slate-800 font-semibold">₹{taxTotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold text-slate-900 pt-2 border-t border-slate-200">
            <span>Payable Amount</span>
            <span className="font-mono text-indigo-600 text-base font-bold">₹{grandTotal.toFixed(2)}</span>
          </div>
        </div>

        <button
          onClick={handleExecuteCheckout}
          disabled={cartItems.length === 0 || checkingOut || !activeSession}
          className="w-full py-3.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-sm shadow-xs flex items-center justify-center space-x-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {checkingOut ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin text-white" />
              <span>Processing Atomic Checkout...</span>
            </>
          ) : (
            <>
              <span>Complete Checkout & Print QR</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>

        {!activeSession && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 text-center font-medium">
            Open an active register session to enable checkout.
          </p>
        )}
      </div>
    </div>
  );
};
