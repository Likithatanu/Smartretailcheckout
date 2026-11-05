import React, { useState } from 'react';
import { X, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { Product } from '../types/database';
import { adjustInventoryStock } from '../lib/supabase';

interface StockAdjustmentModalProps {
  products: Product[];
  selectedProduct?: Product | null;
  onClose: () => void;
  onStockAdjusted: () => void;
}

export const StockAdjustmentModal: React.FC<StockAdjustmentModalProps> = ({
  products,
  selectedProduct,
  onClose,
  onStockAdjusted,
}) => {
  const [productId, setProductId] = useState(selectedProduct?.id || (products[0]?.id || ''));
  const [movementType, setMovementType] = useState<'RESTOCK' | 'CORRECTION' | 'DAMAGE'>('RESTOCK');
  const [quantityDelta, setQuantityDelta] = useState<number>(10);
  const [reason, setReason] = useState('New stock shipment received');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeProduct = products.find(p => p.id === productId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      let delta = Number(quantityDelta);
      if (movementType === 'DAMAGE' && delta > 0) {
        delta = -delta;
      }

      await adjustInventoryStock(productId, delta, movementType, reason.trim());
      onStockAdjusted();
      onClose();
    } catch (err: any) {
      console.error('Failed to adjust stock:', err);
      setErrorMsg(err.message || 'Failed to adjust stock in database.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-md p-6 shadow-xl relative">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3 mb-5">
          <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Stock Adjustment</h2>
            <p className="text-xs text-slate-500">Record immutable inventory movements via database RPC</p>
          </div>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Select Product
            </label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (Current Stock: {p.stock_quantity.toFixed(3)} {p.unit})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Movement Type
              </label>
              <select
                value={movementType}
                onChange={(e) => setMovementType(e.target.value as any)}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              >
                <option value="RESTOCK">RESTOCK (+ Addition)</option>
                <option value="CORRECTION">CORRECTION (Adjustment)</option>
                <option value="DAMAGE">DAMAGE (- Deduction)</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Quantity ({activeProduct?.unit || 'units'})
              </label>
              <input
                type="number"
                step="0.001"
                required
                value={quantityDelta}
                onChange={(e) => setQuantityDelta(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Reason / Audit Memo
            </label>
            <input
              type="text"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Received weekly grain delivery invoice #789"
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-sm shadow-xs flex items-center justify-center space-x-2 transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>{loading ? 'Recording Movement...' : 'Apply Stock Update'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
