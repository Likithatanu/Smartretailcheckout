import React, { useEffect, useState } from 'react';
import { 
  X, 
  ReceiptText, 
  RefreshCw, 
  QrCode, 
  ExternalLink, 
  CheckCircle2, 
  AlertCircle 
} from 'lucide-react';
import type { Order } from '../types/database';
import { getStoreOrders } from '../lib/supabase';

interface OrdersHistoryModalProps {
  storeId: string;
  onClose: () => void;
  onViewReceipt: (token: string) => void;
}

export const OrdersHistoryModal: React.FC<OrdersHistoryModalProps> = ({
  storeId,
  onClose,
  onViewReceipt,
}) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchOrders = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await getStoreOrders(storeId);
      setOrders(data);
    } catch (err: any) {
      console.error('Failed to load store orders:', err);
      setErrorMsg(err.message || 'Failed to retrieve transactions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (storeId) {
      fetchOrders();
    }
  }, [storeId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-4xl p-6 shadow-xl relative max-h-[90vh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 mb-5 pr-8">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
              <ReceiptText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center space-x-2">
                <span>Completed Orders & Receipts</span>
                <span className="text-xs font-mono font-medium bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full border border-slate-200">
                  {orders.length} Transactions
                </span>
              </h2>
              <p className="text-xs text-slate-500">Authorized audit log of completed store checkout transactions</p>
            </div>
          </div>

          <button
            onClick={fetchOrders}
            disabled={loading}
            className="p-2 rounded-xl bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 font-semibold text-xs transition-colors shadow-xs"
            title="Refresh Orders"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Orders Table Container */}
        <div className="flex-1 overflow-y-auto border border-slate-200 rounded-2xl bg-white shadow-xs">
          {loading ? (
            <div className="p-12 text-center text-slate-400 space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600" />
              <span className="text-xs">Loading authorized store orders...</span>
            </div>
          ) : orders.length === 0 ? (
            <div className="p-12 text-center text-slate-400 space-y-3">
              <ReceiptText className="w-10 h-10 mx-auto text-slate-300" />
              <p className="text-sm font-semibold text-slate-700">No checkout transactions yet</p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Completed transactions from the POS terminal will be displayed here with one-click access to verified digital QR receipts.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 uppercase font-semibold text-[10px] tracking-wider sticky top-0">
                <tr>
                  <th className="py-3 px-4">Order #</th>
                  <th className="py-3 px-3">Date & Time</th>
                  <th className="py-3 px-3">Subtotal</th>
                  <th className="py-3 px-3">Tax (GST)</th>
                  <th className="py-3 px-3">Total Amount</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-4 text-right">Receipt Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      #{o.order_number}
                    </td>
                    <td className="py-3 px-3 text-slate-500 font-mono text-[11px]">
                      {new Date(o.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-700">
                      ₹{o.subtotal.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-500">
                      ₹{o.tax_amount.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 font-mono font-bold text-indigo-600 text-sm">
                      ₹{o.total_amount.toFixed(2)}
                    </td>
                    <td className="py-3 px-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        COMPLETED
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => onViewReceipt(o.receipt_token)}
                        className="py-1 px-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-semibold text-[11px] inline-flex items-center space-x-1 transition-colors"
                      >
                        <QrCode className="w-3 h-3" />
                        <span>View QR</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
