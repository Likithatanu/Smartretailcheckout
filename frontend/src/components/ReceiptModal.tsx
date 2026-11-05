import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, QrCode, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { CartItem } from '../types/database';

interface ReceiptModalProps {
  orderResult: {
    order_id: string;
    order_number: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    receipt_token: string;
    items: CartItem[];
  };
  onClose: () => void;
  onViewReceipt: (token: string) => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  orderResult,
  onClose,
  onViewReceipt,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const receiptUrl = `${window.location.origin}/?receipt=${orderResult.receipt_token}`;

  useEffect(() => {
    QRCode.toDataURL(receiptUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#101828',
        light: '#ffffff',
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error('Failed to generate QR code:', err));
  }, [receiptUrl]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-md p-6 shadow-xl relative text-center">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Success Header */}
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 mb-3 shadow-xs">
          <CheckCircle2 className="w-8 h-8" />
        </div>

        <h2 className="text-xl font-bold text-slate-900 tracking-tight">Checkout Completed!</h2>
        <div className="text-xs text-slate-500 mt-0.5">
          Order Number: <span className="font-mono font-bold text-slate-800">#{orderResult.order_number}</span>
        </div>

        {/* QR Code Container */}
        <div className="my-5 p-3.5 bg-white rounded-2xl shadow-xs inline-block mx-auto border-2 border-slate-100">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Customer Digital Receipt QR Code"
              className="w-48 h-48 mx-auto"
            />
          ) : (
            <div className="w-48 h-48 flex items-center justify-center">
              <RefreshCw className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          )}
        </div>

        {/* Customer Scan Call-to-action */}
        <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs text-slate-700 space-y-1 mb-5">
          <div className="font-semibold text-slate-900 flex items-center justify-center space-x-1.5">
            <QrCode className="w-4 h-4 text-indigo-600" />
            <span>Digital QR Receipt for Customer</span>
          </div>
          <p className="text-[11px] text-slate-500">
            Scan this QR code with any smartphone camera to view and download your full digital receipt.
          </p>
          <div className="pt-2 text-slate-500 flex justify-between border-t border-slate-200 text-[11px] font-mono">
            <span>Total Paid:</span>
            <span className="text-indigo-600 font-bold text-xs">₹{orderResult.total_amount.toFixed(2)}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col space-y-2">
          <button
            onClick={() => onViewReceipt(orderResult.receipt_token)}
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-semibold text-xs flex items-center justify-center space-x-2 transition-colors"
          >
            <ExternalLink className="w-4 h-4 text-indigo-600" />
            <span>Open Public Receipt View</span>
          </button>

          <button
            onClick={onClose}
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs transition-colors shadow-xs"
          >
            Start Next Transaction
          </button>
        </div>
      </div>
    </div>
  );
};
