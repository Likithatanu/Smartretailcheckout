import React, { useState, useEffect } from 'react';
import { X, PlusCircle, AlertCircle, Barcode, Wheat, CheckCircle2, Edit3 } from 'lucide-react';
import type { Product, ProductType } from '../types/database';
import { createProduct, updateProduct } from '../lib/supabase';

interface AddProductModalProps {
  storeId: string;
  prefillModelClass?: string | null;
  productToEdit?: Product | null;
  onClose: () => void;
  onProductSaved: (product: Product) => void;
}

export const AddProductModal: React.FC<AddProductModalProps> = ({
  storeId,
  prefillModelClass,
  productToEdit,
  onClose,
  onProductSaved,
}) => {
  const isEditing = !!productToEdit;

  const [name, setName] = useState(productToEdit?.name || '');
  const [productType, setProductType] = useState<ProductType>(
    productToEdit?.product_type || (prefillModelClass ? 'loose' : 'packaged')
  );
  const [modelClass, setModelClass] = useState(
    productToEdit?.model_class || prefillModelClass || 'chana_dal'
  );
  const [barcode, setBarcode] = useState(productToEdit?.barcode || '');
  const initialUnit = (() => {
    if (productToEdit?.unit) {
      const u = productToEdit.unit.trim().toLowerCase();
      return u === 'pcs' ? 'piece' : u;
    }
    return prefillModelClass ? 'kg' : 'piece';
  })();

  const [unit, setUnit] = useState(initialUnit);
  const [pricePerUnit, setPricePerUnit] = useState<number>(productToEdit?.price_per_unit || 100);
  const [taxRatePercent, setTaxRatePercent] = useState<number>(productToEdit?.tax_rate_percent ?? 5);
  const [minStockThreshold, setMinStockThreshold] = useState<number>(productToEdit?.min_stock_threshold ?? 5);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing && prefillModelClass) {
      setProductType('loose');
      setModelClass(prefillModelClass);
      setUnit('kg');
      if (!name) {
        if (prefillModelClass === 'chana_dal') setName('Premium Chana Dal');
        else if (prefillModelClass === 'masur_dal') setName('Organic Masur Dal');
        else if (prefillModelClass === 'rice') setName('Sona Masoori Rice');
      }
    }
  }, [prefillModelClass, isEditing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);

    try {
      const rawUnit = unit.trim().toLowerCase();
      const normalizedUnit = rawUnit === 'pcs' ? 'piece' : rawUnit;

      if (productType === 'packaged') {
        if (!barcode.trim()) {
          throw new Error('Barcode is required for packaged products.');
        }
        if (!['piece', 'pack'].includes(normalizedUnit)) {
          throw new Error("Unit for packaged products must be either 'piece' or 'pack'.");
        }
      }
      if (productType === 'loose') {
        if (!modelClass) {
          throw new Error('AI Model Class is required for loose products.');
        }
        if (normalizedUnit !== 'kg') {
          throw new Error("Unit for loose products must be 'kg'.");
        }
      }
      if (pricePerUnit <= 0) {
        throw new Error('Price per unit must be greater than zero.');
      }

      let saved: Product;

      if (isEditing && productToEdit) {
        saved = await updateProduct(productToEdit.id, {
          name: name.trim(),
          barcode: productType === 'packaged' ? barcode.trim() : null,
          model_class: productType === 'loose' ? modelClass : null,
          price_per_unit: Number(pricePerUnit),
          tax_rate_percent: Number(taxRatePercent),
          min_stock_threshold: Number(minStockThreshold),
          is_active: true,
        });
      } else {
        saved = await createProduct({
          store_id: storeId,
          name: name.trim(),
          product_type: productType,
          model_class: productType === 'loose' ? modelClass : null,
          barcode: productType === 'packaged' ? barcode.trim() : null,
          unit: normalizedUnit,
          price_per_unit: Number(pricePerUnit),
          tax_rate_percent: Number(taxRatePercent),
          min_stock_threshold: Number(minStockThreshold),
          is_active: true,
        });
      }

      onProductSaved(saved);
      onClose();
    } catch (err: any) {
      console.error('Failed to save product:', err);
      setErrorMsg(err.message || 'Database error occurred while saving product.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-lg p-6 shadow-xl relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center space-x-3 mb-5">
          <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
            {isEditing ? <Edit3 className="w-5 h-5" /> : <PlusCircle className="w-5 h-5" />}
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {isEditing ? 'Edit Product Details' : 'Register New Store Product'}
            </h2>
            <p className="text-xs text-slate-500">
              {isEditing
                ? 'Update pricing, barcode, or thresholds in Supabase'
                : 'Add a new barcode item or AI loose grain to this store'}
            </p>
          </div>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
            <div className="flex-1 font-medium">{errorMsg}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Product Type Selector */}
          <div>
            <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Product Category
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isEditing}
                onClick={() => {
                  setProductType('packaged');
                  setUnit('piece');
                }}
                className={`p-3 rounded-xl border flex items-center space-x-2.5 transition-all text-left ${
                  productType === 'packaged'
                    ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Barcode className="w-4 h-4 text-indigo-600" />
                <div>
                  <div className="font-bold text-xs">Packaged Item</div>
                  <div className="text-[10px] text-slate-500">Scanned via barcode</div>
                </div>
              </button>

              <button
                type="button"
                disabled={isEditing}
                onClick={() => {
                  setProductType('loose');
                  setUnit('kg');
                }}
                className={`p-3 rounded-xl border flex items-center space-x-2.5 transition-all text-left ${
                  productType === 'loose'
                    ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Wheat className="w-4 h-4 text-indigo-600" />
                <div>
                  <div className="font-bold text-xs">Loose Grain</div>
                  <div className="text-[10px] text-slate-500">AI webcam + HX711 scale</div>
                </div>
              </button>
            </div>
          </div>

          {/* Product Name */}
          <div>
            <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Product Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sona Masoori Rice, Britannia Bourbon..."
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
            />
          </div>

          {/* Loose Product: AI Model Class mapping */}
          {productType === 'loose' && (
            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                ConvNeXt-Tiny Class Mapping
              </label>
              <select
                value={modelClass}
                onChange={(e) => setModelClass(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              >
                <option value="chana_dal">chana_dal (Chana Dal / Bengal Gram)</option>
                <option value="masur_dal">masur_dal (Masur Dal / Red Lentil)</option>
                <option value="rice">rice (Loose Grains / Rice)</option>
              </select>
            </div>
          )}

          {/* Packaged Product: Barcode */}
          {productType === 'packaged' && (
            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                UPC / EAN Barcode
              </label>
              <input
                type="text"
                required
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="e.g. 8901030384812"
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
            </div>
          )}

          {/* Pricing, Unit, Tax */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Price (₹)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={pricePerUnit}
                onChange={(e) => setPricePerUnit(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Unit
              </label>
              <input
                type="text"
                required
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder={productType === 'loose' ? 'kg' : 'piece or pack'}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                {productType === 'loose' ? 'Accepted: kg' : 'Accepted: piece, pack'}
              </p>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Tax (GST %)
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                required
                value={taxRatePercent}
                onChange={(e) => setTaxRatePercent(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
              />
            </div>
          </div>

          {/* Low Stock Warning Threshold */}
          <div>
            <label className="block font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Low Stock Alert Threshold ({unit})
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              required
              value={minStockThreshold}
              onChange={(e) => setMinStockThreshold(Number(e.target.value))}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Triggers warning badge when real inventory falls below this amount.
            </p>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-sm shadow-xs flex items-center justify-center space-x-2 transition-all disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>{loading ? 'Saving to Database...' : isEditing ? 'Update Product' : 'Register Product in Catalog'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
