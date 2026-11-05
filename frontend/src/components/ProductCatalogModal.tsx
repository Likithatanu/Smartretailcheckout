import React, { useState, useEffect } from 'react';
import { 
  X, 
  Package, 
  Search, 
  PlusCircle, 
  TrendingUp, 
  AlertTriangle, 
  Wheat, 
  Barcode, 
  RefreshCw,
  History,
  Edit3
} from 'lucide-react';
import type { Product, InventoryMovement } from '../types/database';
import { getStoreInventoryMovements } from '../lib/supabase';

interface ProductCatalogModalProps {
  storeId: string;
  products: Product[];
  onClose: () => void;
  onOpenAddModal: () => void;
  onOpenEditModal: (product: Product) => void;
  onOpenStockModal: (product?: Product) => void;
  onRefreshProducts: () => void;
}

export const ProductCatalogModal: React.FC<ProductCatalogModalProps> = ({
  storeId,
  products,
  onClose,
  onOpenAddModal,
  onOpenEditModal,
  onOpenStockModal,
  onRefreshProducts,
}) => {
  const [activeTab, setActiveTab] = useState<'products' | 'movements'>('products');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'loose' | 'packaged' | 'low_stock'>('all');

  // Inventory movements state
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(false);
  const [movementsError, setMovementsError] = useState<string | null>(null);

  // Fetch real inventory movements when tab is clicked
  useEffect(() => {
    if (activeTab === 'movements' && storeId) {
      let isMounted = true;
      setLoadingMovements(true);
      setMovementsError(null);

      getStoreInventoryMovements(storeId)
        .then((data) => {
          if (isMounted) setMovements(data);
        })
        .catch((err: any) => {
          if (isMounted) setMovementsError(err.message || 'Failed to load movements.');
        })
        .finally(() => {
          if (isMounted) setLoadingMovements(false);
        });

      return () => {
        isMounted = false;
      };
    }
  }, [activeTab, storeId]);

  const filteredProducts = products.filter((p) => {
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.includes(q)) ||
      (p.model_class && p.model_class.toLowerCase().includes(q));

    let matchesType = true;
    if (filterType === 'loose') matchesType = p.product_type === 'loose';
    else if (filterType === 'packaged') matchesType = p.product_type === 'packaged';
    else if (filterType === 'low_stock') matchesType = p.stock_quantity <= p.min_stock_threshold;

    return matchesSearch && matchesType;
  });

  const lowStockCount = products.filter(p => p.stock_quantity <= p.min_stock_threshold).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-5xl p-6 shadow-xl relative max-h-[90vh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pr-8">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center space-x-2">
                <span>Product Catalog & Inventory</span>
                <span className="text-xs font-mono font-medium bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full border border-slate-200">
                  {products.length} Products
                </span>
                {lowStockCount > 0 && (
                  <span className="text-xs font-medium bg-amber-50 text-amber-700 px-2.5 py-0.5 rounded-full border border-amber-200">
                    {lowStockCount} Low Stock
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500">Real store inventory synchronized with Supabase database</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onRefreshProducts}
              title="Refresh Products"
              className="p-2 rounded-xl bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 font-semibold text-xs transition-colors shadow-xs"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            <button
              onClick={() => onOpenStockModal()}
              disabled={products.length === 0}
              className="py-2 px-3 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold text-xs flex items-center space-x-1.5 transition-colors shadow-xs disabled:opacity-40"
            >
              <TrendingUp className="w-3.5 h-3.5 text-indigo-600" />
              <span>Adjust Stock</span>
            </button>

            <button
              onClick={onOpenAddModal}
              className="py-2 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs flex items-center space-x-1.5 transition-colors shadow-xs"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Add Product</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 mb-4 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('products')}
            className={`pb-2.5 px-3 border-b-2 flex items-center space-x-1.5 transition-colors ${
              activeTab === 'products'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Package className="w-4 h-4" />
            <span>Store Products ({products.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('movements')}
            className={`pb-2.5 px-3 border-b-2 flex items-center space-x-1.5 transition-colors ${
              activeTab === 'movements'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Inventory Movement History</span>
          </button>
        </div>

        {/* PRODUCTS TAB */}
        {activeTab === 'products' && (
          <>
            {/* Filter & Search Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by product name, barcode, or AI class..."
                  className="w-full pl-10 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              {/* Filter Pills */}
              <div className="flex items-center space-x-1.5 bg-slate-50 p-1 rounded-xl border border-slate-200 text-xs">
                <button
                  onClick={() => setFilterType('all')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterType === 'all'
                      ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All ({products.length})
                </button>
                <button
                  onClick={() => setFilterType('loose')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterType === 'loose'
                      ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Loose Grains
                </button>
                <button
                  onClick={() => setFilterType('packaged')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterType === 'packaged'
                      ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Packaged Barcode
                </button>
                <button
                  onClick={() => setFilterType('low_stock')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    filterType === 'low_stock'
                      ? 'bg-white text-amber-700 shadow-xs border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Low Stock ({lowStockCount})
                </button>
              </div>
            </div>

            {/* Product Table Container */}
            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-2xl bg-white shadow-xs">
              {filteredProducts.length === 0 ? (
                <div className="p-12 text-center text-slate-400 space-y-3">
                  <Package className="w-10 h-10 mx-auto text-slate-300" />
                  <p className="text-sm font-semibold text-slate-700">No products found</p>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    {searchQuery
                      ? 'No items matched your search query. Try clearing the filter.'
                      : 'Your store catalog is currently empty. Click "Add Product" to create your first item.'}
                  </p>
                  <button
                    onClick={onOpenAddModal}
                    className="mt-2 py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs transition-colors"
                  >
                    Add First Product
                  </button>
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 uppercase font-semibold text-[10px] tracking-wider sticky top-0">
                    <tr>
                      <th className="py-3 px-4">Product Details</th>
                      <th className="py-3 px-3">Type</th>
                      <th className="py-3 px-3">Barcode / AI Class</th>
                      <th className="py-3 px-3">Unit Price</th>
                      <th className="py-3 px-3">Stock Level</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredProducts.map((p) => {
                      const isLow = p.stock_quantity <= p.min_stock_threshold;
                      const isLoose = p.product_type === 'loose';

                      return (
                        <tr key={p.id} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-900">{p.name}</div>
                            <div className="text-[10px] text-slate-400">ID: {p.id.slice(0, 8)}...</div>
                          </td>

                          <td className="py-3 px-3">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                isLoose
                                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                  : 'bg-slate-100 text-slate-700 border border-slate-200'
                              }`}
                            >
                              {isLoose ? <Wheat className="w-3 h-3 mr-1" /> : <Barcode className="w-3 h-3 mr-1" />}
                              {isLoose ? 'Loose' : 'Packaged'}
                            </span>
                          </td>

                          <td className="py-3 px-3 font-mono text-slate-600">
                            {isLoose ? (
                              <span className="text-indigo-600 font-semibold">{p.model_class || '—'}</span>
                            ) : (
                              <span>{p.barcode || '—'}</span>
                            )}
                          </td>

                          <td className="py-3 px-3">
                            <div className="font-bold font-mono text-slate-900">₹{p.price_per_unit.toFixed(2)}</div>
                            <div className="text-[10px] text-slate-500">per {p.unit} (+{p.tax_rate_percent}% GST)</div>
                          </td>

                          <td className="py-3 px-3">
                            <div className="flex items-center space-x-1.5">
                              <span className={`font-bold font-mono ${isLow ? 'text-amber-600' : 'text-slate-900'}`}>
                                {p.stock_quantity.toFixed(3)}
                              </span>
                              <span className="text-[11px] text-slate-500">{p.unit}</span>
                              {isLow && (
                                <span title={`Below threshold of ${p.min_stock_threshold}`}>
                                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400">Min: {p.min_stock_threshold} {p.unit}</div>
                          </td>

                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end space-x-1.5">
                              <button
                                onClick={() => onOpenEditModal(p)}
                                title="Edit Product"
                                className="py-1 px-2.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-semibold text-[11px] flex items-center space-x-1 shadow-xs transition-colors"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>Edit</span>
                              </button>
                              <button
                                onClick={() => onOpenStockModal(p)}
                                title="Adjust Stock"
                                className="py-1 px-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-semibold text-[11px] flex items-center space-x-1 transition-colors"
                              >
                                <TrendingUp className="w-3 h-3" />
                                <span>Stock</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {/* MOVEMENTS AUDIT TAB */}
        {activeTab === 'movements' && (
          <div className="flex-1 overflow-y-auto border border-slate-200 rounded-2xl bg-white shadow-xs">
            {loadingMovements ? (
              <div className="p-12 text-center text-slate-400 space-y-2">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600" />
                <span className="text-xs">Loading authorized inventory audit records...</span>
              </div>
            ) : movementsError ? (
              <div className="p-6 text-center text-rose-600 text-xs">
                Failed to load movement records: {movementsError}
              </div>
            ) : movements.length === 0 ? (
              <div className="p-12 text-center text-slate-400 space-y-2">
                <History className="w-10 h-10 mx-auto text-slate-300" />
                <p className="text-sm font-semibold text-slate-700">No inventory movements recorded yet</p>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  When you restock products or complete sales transactions, atomic stock movements are logged here.
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 uppercase font-semibold text-[10px] tracking-wider sticky top-0">
                  <tr>
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-3">Product</th>
                    <th className="py-3 px-3">Movement Type</th>
                    <th className="py-3 px-3">Quantity Delta</th>
                    <th className="py-3 px-3">Resulting Stock</th>
                    <th className="py-3 px-4">Audit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movements.map((m) => {
                    const isPositive = m.quantity_delta > 0;
                    return (
                      <tr key={m.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                          {new Date(m.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-900">
                          {m.product?.name || m.product_id.slice(0, 8)}
                        </td>
                        <td className="py-3 px-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              m.movement_type === 'RESTOCK'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : m.movement_type === 'SALE'
                                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                : m.movement_type === 'DAMAGE'
                                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}
                          >
                            {m.movement_type}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono font-bold">
                          <span className={isPositive ? 'text-emerald-700' : 'text-slate-800'}>
                            {isPositive ? `+${m.quantity_delta}` : m.quantity_delta}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-800 font-semibold">
                          {m.resulting_stock.toFixed(3)}
                        </td>
                        <td className="py-3 px-4 text-slate-600 max-w-xs truncate" title={m.reason}>
                          {m.reason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
