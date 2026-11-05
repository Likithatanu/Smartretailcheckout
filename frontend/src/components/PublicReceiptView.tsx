import React, { useEffect, useState } from 'react';
import { 
  Receipt, 
  Store, 
  Clock, 
  Printer, 
  ArrowLeft, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  ShieldCheck 
} from 'lucide-react';
import type { PublicReceipt } from '../types/database';
import { getReceiptByToken } from '../lib/supabase';

interface PublicReceiptViewProps {
  receiptToken: string;
  onBackToPos?: () => void;
}

export const PublicReceiptView: React.FC<PublicReceiptViewProps> = ({
  receiptToken,
  onBackToPos,
}) => {
  const [receipt, setReceipt] = useState<PublicReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function fetchReceipt() {
      setLoading(true);
      setErrorMsg(null);
      try {
        const data = await getReceiptByToken(receiptToken);
        setReceipt(data);
      } catch (err: any) {
        console.error('Failed to load public receipt:', err);
        setErrorMsg(err.message || 'Receipt not found or invalid receipt token.');
      } finally {
        setLoading(false);
      }
    }

    if (receiptToken) {
      fetchReceipt();
    }
  }, [receiptToken]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 text-center">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-600 mb-3" />
        <h2 className="text-base font-semibold text-slate-900">Loading Digital Receipt...</h2>
        <p className="text-xs text-slate-500 mt-1">Retrieving verified snapshot from Supabase</p>
      </div>
    );
  }

  if (errorMsg || !receipt) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 text-center max-w-md mx-auto">
        <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 mb-3">
          <AlertCircle className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">Receipt Verification Failed</h2>
        <p className="text-xs text-slate-500 mt-1 mb-5">{errorMsg || 'Receipt could not be loaded.'}</p>
        {onBackToPos && (
          <button
            onClick={onBackToPos}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white transition-colors shadow-xs"
          >
            Back to Checkout Terminal
          </button>
        )}
      </div>
    );
  }

  const isCancelled = receipt.status === 'cancelled';
  const displayDate = receipt.date || receipt.created_at;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 flex flex-col items-center">
      {/* Top action bar */}
      <div className="w-full max-w-lg flex items-center justify-between mb-4 print:hidden">
        {onBackToPos && (
          <button
            onClick={onBackToPos}
            className="text-xs font-semibold text-slate-500 hover:text-slate-900 flex items-center space-x-1.5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Terminal</span>
          </button>
        )}
        <button
          onClick={handlePrint}
          className="ml-auto px-3.5 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 flex items-center space-x-1.5 transition-colors border border-slate-200 shadow-xs"
        >
          <Printer className="w-3.5 h-3.5 text-slate-500" />
          <span>Print Receipt</span>
        </button>
      </div>

      {/* Main Digital Receipt Card */}
      <div className="w-full max-w-lg bg-white rounded-3xl border border-slate-200 p-8 shadow-sm relative text-slate-800">
        {/* Top Header */}
        <div className="text-center pb-6 border-b border-dashed border-slate-200">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 mx-auto mb-2">
            <Store className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">{receipt.store_name}</h1>
          {receipt.store_address && (
            <p className="text-xs text-slate-500 mt-0.5">{receipt.store_address}</p>
          )}
          <div className="mt-3 inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">
            <CheckCircle2 className="w-3 h-3" />
            <span>Verified Digital Receipt</span>
          </div>
        </div>

        {/* Cancellation Notice if applicable */}
        {isCancelled && (
          <div className="my-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs">
            <div className="font-bold flex items-center space-x-1">
              <AlertCircle className="w-4 h-4" />
              <span>TRANSACTION CANCELLED</span>
            </div>
            {receipt.cancellation && (
              <div className="mt-1 text-[11px] text-rose-600">
                Cancelled on: {new Date(receipt.cancellation.cancelled_at).toLocaleString()}
                <br />
                Reason: {receipt.cancellation.reason}
              </div>
            )}
          </div>
        )}

        {/* Order Metadata */}
        <div className="my-4 py-2 border-b border-slate-100 flex justify-between items-center text-xs">
          <div>
            <span className="text-slate-400 block text-[10px]">ORDER NUMBER</span>
            <span className="font-mono font-bold text-slate-900">#{receipt.order_number}</span>
          </div>
          <div className="text-right">
            <span className="text-slate-400 block text-[10px]">DATE & TIME</span>
            <span className="font-mono text-slate-600">
              {displayDate ? new Date(displayDate).toLocaleString() : 'N/A'}
            </span>
          </div>
        </div>

        {/* Items List */}
        <div className="py-2 space-y-3">
          <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 pb-1">
            <span>Item & Qty</span>
            <span className="text-right">Amount</span>
          </div>

          {receipt.items.map((item, idx) => (
            <div key={idx} className="flex justify-between items-start text-xs">
              <div className="flex-1 pr-4">
                <div className="font-semibold text-slate-900">{item.name}</div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {item.quantity_or_weight.toFixed(3)} {item.unit} @ ₹{item.unit_price.toFixed(2)}/{item.unit}
                </div>
              </div>
              <div className="text-right font-mono font-bold text-slate-900">
                ₹{item.item_total.toFixed(2)}
              </div>
            </div>
          ))}
        </div>

        {/* Financial Summary */}
        <div className="mt-5 pt-4 border-t border-slate-200 space-y-1.5 text-xs">
          <div className="flex justify-between text-slate-600">
            <span>Base Subtotal:</span>
            <span className="font-mono text-slate-900">₹{receipt.subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Tax (GST):</span>
            <span className="font-mono text-slate-900">₹{receipt.tax_amount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-base font-bold text-slate-900 pt-3 border-t border-slate-200">
            <span>Total Paid:</span>
            <span className="font-mono text-indigo-600">₹{receipt.total_amount.toFixed(2)}</span>
          </div>
        </div>

        {/* Footer Security Seal */}
        <div className="mt-8 pt-4 border-t border-dashed border-slate-200 text-center text-slate-400 space-y-1">
          <div className="flex items-center justify-center space-x-1 text-[11px] text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
            <span>Cryptographically sealed record in PostgreSQL</span>
          </div>
          <p className="text-[10px]">Thank you for shopping with AI Smart Retail!</p>
        </div>
      </div>
    </div>
  );
};
