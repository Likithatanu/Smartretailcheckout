import React, { useEffect, useRef } from 'react';
import type { Product, CartItem } from '../types/database';
import { getProductByBarcode } from '../lib/supabase';
import { playScanBeep, playErrorAlert } from '../lib/sound';

interface ScannerListenerProps {
  storeId: string;
  onAddToCart: (item: CartItem) => void;
  onBarcodeNotFound: (barcode: string) => void;
}

export const ScannerListener: React.FC<ScannerListenerProps> = ({
  storeId,
  onAddToCart,
  onBarcodeNotFound,
}) => {
  const bufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // If user is typing in an active text input or textarea, don't hijack keyboard
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      const now = Date.now();
      const timeDiff = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      // Scanners type very quickly (<60ms per char). If slow typing (>200ms), reset buffer
      if (timeDiff > 200) {
        bufferRef.current = '';
      }

      if (e.key === 'Enter') {
        const barcode = bufferRef.current.trim();
        bufferRef.current = '';

        if (barcode.length >= 3) {
          e.preventDefault();
          try {
            const product = await getProductByBarcode(storeId, barcode);
            if (product) {
              playScanBeep();
              // Calculate for 1 quantity (packaged goods default)
              const qty = 1;
              const unitPrice = product.price_per_unit;
              const taxRate = product.tax_rate_percent;
              const baseSubtotal = Number((unitPrice * qty).toFixed(2));
              const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
              const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));

              onAddToCart({
                product,
                quantity_or_weight: qty,
                base_subtotal: baseSubtotal,
                tax_amount: taxAmount,
                item_total: itemTotal,
                detection_source: 'barcode_scanner',
              });
            } else {
              playErrorAlert();
              onBarcodeNotFound(barcode);
            }
          } catch (err) {
            console.error('Barcode scan lookup error:', err);
            playErrorAlert();
          }
        }
      } else if (e.key.length === 1) {
        // Printable ASCII character
        bufferRef.current += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [storeId, onAddToCart, onBarcodeNotFound]);

  return null; // Headless component
};
