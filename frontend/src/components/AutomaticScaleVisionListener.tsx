import React, { useEffect, useRef } from 'react';
import type { CartItem } from '../types/database';
import { getScaleReading, predictVision } from '../lib/bridgeApi';
import { getProductByModelClass } from '../lib/supabase';
import { playVisionChime, playScaleStabilized, playErrorAlert } from '../lib/sound';

export type AutoVisionState = 'ARMED' | 'STABILIZING' | 'PROCESSING' | 'WAITING_FOR_REMOVAL';

export interface AutoVisionStatusInfo {
  state: AutoVisionState;
  message: string;
  detail?: string;
  type: 'idle' | 'info' | 'success' | 'warning' | 'error';
  timestamp?: number;
}

interface AutomaticScaleVisionListenerProps {
  storeId: string;
  enabled: boolean;
  onAddToCart: (item: CartItem) => void;
  onStatusChange?: (status: AutoVisionStatusInfo | null) => void;
}

const EMPTY_THRESHOLD_GRAMS = 5.0; // Under 5.0g is considered empty scale or tare drift
const MIN_STABLE_WEIGHT_GRAMS = 10.0; // Minimum weight required to initiate classification
const STABILITY_SPREAD_GRAMS = 1.5; // Max difference across window samples to declare stability
const STABILITY_SAMPLES_COUNT = 3; // Number of consecutive stable readings required
const POLL_INTERVAL_MS = 400; // Scale polling cadence (ms)

export const AutomaticScaleVisionListener: React.FC<AutomaticScaleVisionListenerProps> = ({
  storeId,
  enabled,
  onAddToCart,
  onStatusChange,
}) => {
  const listenerStateRef = useRef<AutoVisionState>('ARMED');
  const recentWeightsRef = useRef<number[]>([]);
  const emptyCounterRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);

  // Keep latest callbacks in refs to avoid recreating the interval on parent re-renders
  const onAddToCartRef = useRef(onAddToCart);
  onAddToCartRef.current = onAddToCart;

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const storeIdRef = useRef(storeId);
  storeIdRef.current = storeId;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let isMounted = true;

    const reportStatus = (info: AutoVisionStatusInfo | null) => {
      if (onStatusChangeRef.current) {
        onStatusChangeRef.current(info);
      }
    };

    const runAutoRecognition = async (stableWeightGrams: number) => {
      if (isExecutingRef.current) return;
      isExecutingRef.current = true;
      listenerStateRef.current = 'PROCESSING';

      reportStatus({
        state: 'PROCESSING',
        type: 'info',
        message: `Weighed ${stableWeightGrams.toFixed(1)}g. Analyzing camera frame...`,
        detail: 'Running ConvNeXt-Tiny classification on scale zone',
        timestamp: Date.now(),
      });

      playScaleStabilized();

      try {
        // 1. Capture camera frame and execute ConvNeXt-Tiny prediction via local bridge
        const prediction = await predictVision();

        // 2. Reject predictions below 75% confidence threshold (matching model config)
        if (!prediction.is_confident || prediction.confidence < (prediction.confidence_threshold || 0.75)) {
          playErrorAlert();
          reportStatus({
            state: 'WAITING_FOR_REMOVAL',
            type: 'warning',
            message: `AI Uncertain: ${prediction.predicted_class} (${Math.round(prediction.confidence * 100)}% confidence < 75%). Item not added.`,
            detail: 'Please adjust produce or use manual AI Camera capture.',
            timestamp: Date.now(),
          });
          listenerStateRef.current = 'WAITING_FOR_REMOVAL';
          emptyCounterRef.current = 0;
          return;
        }

        // 3. Look up matching loose produce in real Supabase catalog for this store
        const product = await getProductByModelClass(storeIdRef.current, prediction.predicted_class);
        if (!product) {
          playErrorAlert();
          reportStatus({
            state: 'WAITING_FOR_REMOVAL',
            type: 'warning',
            message: `Product "${prediction.predicted_class}" recognized, but no matching loose item found in this store's catalog.`,
            detail: 'Please register this product in the store catalog first.',
            timestamp: Date.now(),
          });
          listenerStateRef.current = 'WAITING_FOR_REMOVAL';
          emptyCounterRef.current = 0;
          return;
        }

        // 4. Calculate fractional kilograms, subtotal, and tax based on genuine database price
        const weightKg = Number((stableWeightGrams / 1000).toFixed(3));
        const unitPrice = product.price_per_unit;
        const taxRate = product.tax_rate_percent;

        const baseSubtotal = Number((unitPrice * weightKg).toFixed(2));
        const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
        const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));

        // 5. Automatically append to unified bill
        onAddToCartRef.current({
          product,
          quantity_or_weight: weightKg,
          base_subtotal: baseSubtotal,
          tax_amount: taxAmount,
          item_total: itemTotal,
          detection_source: 'ai_camera',
          confidence: prediction.confidence,
          weight_grams: stableWeightGrams,
        });

        // 6. Audio and visual success confirmation
        playVisionChime();
        reportStatus({
          state: 'WAITING_FOR_REMOVAL',
          type: 'success',
          message: `Auto-added: ${product.name} (${weightKg.toFixed(3)} kg) — ₹${itemTotal.toFixed(2)}`,
          detail: 'Please remove item from weighing platform.',
          timestamp: Date.now(),
        });

        // 7. Lock state to WAITING_FOR_REMOVAL (strictly prohibits duplicate additions)
        listenerStateRef.current = 'WAITING_FOR_REMOVAL';
        emptyCounterRef.current = 0;
      } catch (err: any) {
        console.error('Automatic AI Vision Recognition error:', err);
        playErrorAlert();
        reportStatus({
          state: 'WAITING_FOR_REMOVAL',
          type: 'error',
          message: `Vision error: ${err.message || 'Failed to classify produce'}`,
          detail: 'Please remove item or use manual capture.',
          timestamp: Date.now(),
        });
        listenerStateRef.current = 'WAITING_FOR_REMOVAL';
        emptyCounterRef.current = 0;
      } finally {
        isExecutingRef.current = false;
      }
    };

    const pollScaleAndDetect = async () => {
      if (!isMounted || !enabledRef.current || !storeIdRef.current) {
        return;
      }

      // If already executing an inference request, don't overlap
      if (isExecutingRef.current) {
        return;
      }

      try {
        const scaleReading = await getScaleReading();
        if (!isMounted) return;

        // Check for sensor error
        if (scaleReading.status === 'sensor_error') {
          reportStatus({
            state: listenerStateRef.current,
            type: 'error',
            message: 'Scale sensor error: HX711 not ready.',
            detail: 'Check load cell connection on COM3.',
            timestamp: Date.now(),
          });
          return;
        }

        if (!scaleReading.connected || scaleReading.weight_grams === null) {
          // Hardware disconnected; keep state intact
          return;
        }

        const currentWeight = scaleReading.weight_grams;

        // =====================================================================
        // STATE: WAITING_FOR_REMOVAL
        // An item has been processed (or errored). We strictly wait until the
        // scale returns to an empty/unloaded state (< 5.0g) before re-arming.
        // =====================================================================
        if (listenerStateRef.current === 'WAITING_FOR_REMOVAL') {
          if (currentWeight < EMPTY_THRESHOLD_GRAMS) {
            emptyCounterRef.current += 1;
            // Require 2 consecutive empty readings (~800ms) to confirm genuine removal
            if (emptyCounterRef.current >= 2) {
              listenerStateRef.current = 'ARMED';
              recentWeightsRef.current = [];
              emptyCounterRef.current = 0;
              reportStatus({
                state: 'ARMED',
                type: 'idle',
                message: 'Scale Ready (Empty)',
                detail: 'Place loose produce on platform to recognize automatically.',
                timestamp: Date.now(),
              });
            }
          } else {
            emptyCounterRef.current = 0;
          }
          return;
        }

        // =====================================================================
        // STATE: ARMED (Empty scale, ready for produce)
        // =====================================================================
        if (listenerStateRef.current === 'ARMED') {
          if (currentWeight < MIN_STABLE_WEIGHT_GRAMS) {
            // Still empty or minor tare drift
            recentWeightsRef.current = [];
            return;
          }

          // Weight detected above threshold! Transition to STABILIZING
          listenerStateRef.current = 'STABILIZING';
          recentWeightsRef.current = [currentWeight];
          reportStatus({
            state: 'STABILIZING',
            type: 'info',
            message: `Stabilizing: ${currentWeight.toFixed(1)}g...`,
            detail: 'Hold item steady on weighing platform.',
            timestamp: Date.now(),
          });
          return;
        }

        // =====================================================================
        // STATE: STABILIZING (Item placed, verifying stability over sliding window)
        // =====================================================================
        if (listenerStateRef.current === 'STABILIZING') {
          if (currentWeight < EMPTY_THRESHOLD_GRAMS) {
            // Item was lifted prematurely before stabilizing
            listenerStateRef.current = 'ARMED';
            recentWeightsRef.current = [];
            reportStatus(null);
            return;
          }

          recentWeightsRef.current.push(currentWeight);
          if (recentWeightsRef.current.length > STABILITY_SAMPLES_COUNT) {
            recentWeightsRef.current.shift();
          }

          if (recentWeightsRef.current.length >= STABILITY_SAMPLES_COUNT) {
            const maxW = Math.max(...recentWeightsRef.current);
            const minW = Math.min(...recentWeightsRef.current);
            const spread = maxW - minW;

            if (spread <= STABILITY_SPREAD_GRAMS && currentWeight >= MIN_STABLE_WEIGHT_GRAMS) {
              // Stability confirmed! Compute average stable weight
              const avgWeight = Number(
                (recentWeightsRef.current.reduce((a, b) => a + b, 0) / recentWeightsRef.current.length).toFixed(1)
              );
              recentWeightsRef.current = [];
              await runAutoRecognition(avgWeight);
            } else {
              reportStatus({
                state: 'STABILIZING',
                type: 'info',
                message: `Stabilizing: ${currentWeight.toFixed(1)}g...`,
                detail: `Weight settling (spread: ${spread.toFixed(1)}g). Keep still.`,
                timestamp: Date.now(),
              });
            }
          }
        }
      } catch (err) {
        // Polling error (e.g. temporary bridge glitch)
        console.debug('Scale auto-poll error:', err);
      }
    };

    const interval = setInterval(pollScaleAndDetect, POLL_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return null; // Headless component
};
