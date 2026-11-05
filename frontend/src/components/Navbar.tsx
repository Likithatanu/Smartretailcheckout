import React from 'react';
import { 
  Store as StoreIcon, 
  User, 
  LogOut, 
  Clock, 
  Scale, 
  Camera, 
  Cpu, 
  Package, 
  ShieldCheck, 
  ReceiptText
} from 'lucide-react';
import type { Profile, RegisterSession, BridgeHealth, ScaleStatus } from '../types/database';

interface NavbarProps {
  profile: Profile | null;
  activeSession: RegisterSession | null;
  bridgeHealth: BridgeHealth | null;
  scaleStatus: ScaleStatus | null;
  onOpenSessionModal: () => void;
  onOpenCatalogModal: () => void;
  onOpenOrdersModal?: () => void;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  profile,
  activeSession,
  bridgeHealth,
  scaleStatus,
  onOpenSessionModal,
  onOpenCatalogModal,
  onOpenOrdersModal,
  onLogout,
}) => {
  const isScaleConnected = scaleStatus?.connected ?? false;
  const isBridgeConnected = bridgeHealth?.api_running ?? false;
  const isCameraAvailable = bridgeHealth?.camera_available ?? false;

  return (
    <header className="bg-white/95 backdrop-blur-md border-b border-slate-200 sticky top-0 z-30 px-4 py-3 shadow-xs">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Left: Brand & Store Badge */}
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-50 border border-indigo-100 p-2 rounded-xl flex items-center justify-center text-indigo-600 shadow-xs">
            <StoreIcon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-base text-slate-900 tracking-tight">AI Smart Retail</span>
              <span className="text-[10px] uppercase font-semibold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-100">
                Checkout POS
              </span>
            </div>
            <div className="text-xs text-slate-500 flex items-center space-x-2 mt-0.5">
              <span className="font-medium text-slate-700">{profile?.store?.name || 'Authorized Store'}</span>
              <span className="text-slate-300">•</span>
              <span className="font-mono text-[11px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded border border-slate-200">
                {profile?.store?.store_code || 'STORE-01'}
              </span>
            </div>
          </div>
        </div>

        {/* Center: Hardware Diagnostics Pills */}
        <div className="hidden lg:flex items-center space-x-2 bg-slate-50 p-1 rounded-xl border border-slate-200">
          {/* Bridge API status */}
          <div 
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              isBridgeConnected 
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                : 'bg-rose-50 text-rose-700 border border-rose-200'
            }`}
            title={isBridgeConnected ? `Python Bridge active (Model: ${bridgeHealth?.active_model_version || 'v2'})` : 'Python Bridge offline (127.0.0.1:8000)'}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>AI Bridge</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isBridgeConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
          </div>

          {/* HX711 Scale status */}
          <div 
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              isScaleConnected 
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                : 'bg-amber-50 text-amber-700 border border-amber-200'
            }`}
            title={isScaleConnected ? `HX711 Load Cell connected on ${scaleStatus?.port || 'COM3'}` : `Scale: ${scaleStatus?.status || 'disconnected'}`}
          >
            <Scale className="w-3.5 h-3.5" />
            <span>HX711 Scale</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isScaleConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          </div>

          {/* Camera status */}
          <div 
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              isCameraAvailable 
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                : 'bg-slate-100 text-slate-500 border border-slate-200'
            }`}
            title={isCameraAvailable ? 'Webcam ready for AI classification' : 'Webcam in browser mode'}
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Camera</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isCameraAvailable ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          </div>
        </div>

        {/* Right: Register Session, Catalog, Orders, User, Logout */}
        <div className="flex items-center space-x-2">
          {/* Active Register Session Button */}
          <button
            onClick={onOpenSessionModal}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
              activeSession
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 animate-pulse'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>{activeSession ? activeSession.register_name : 'No Active Session'}</span>
          </button>

          {/* Catalog & Inventory Modal Button */}
          <button
            onClick={onOpenCatalogModal}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-700 shadow-xs transition-colors"
          >
            <Package className="w-3.5 h-3.5 text-indigo-600" />
            <span>Catalog & Stock</span>
          </button>

          {/* Orders History Button */}
          {onOpenOrdersModal && (
            <button
              onClick={onOpenOrdersModal}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-700 shadow-xs transition-colors"
            >
              <ReceiptText className="w-3.5 h-3.5 text-slate-500" />
              <span className="hidden sm:inline">Orders</span>
            </button>
          )}

          {/* User profile badge */}
          <div className="hidden sm:flex items-center space-x-2 px-2.5 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
            <User className="w-3.5 h-3.5 text-slate-500" />
            <div className="flex flex-col text-left">
              <span className="font-semibold text-slate-800 leading-tight">
                {profile?.full_name || 'Retailer'}
              </span>
              <span className="text-[10px] text-slate-500 capitalize flex items-center">
                <ShieldCheck className="w-2.5 h-2.5 mr-0.5 text-indigo-600" />
                {profile?.role ? profile.role.replace('_', ' ') : 'Cashier'}
              </span>
            </div>
          </div>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            title="Log Out"
            className="p-2 rounded-xl bg-white hover:bg-rose-50 hover:text-rose-600 border border-slate-200 hover:border-rose-200 text-slate-500 shadow-xs transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
