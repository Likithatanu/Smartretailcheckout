import React, { useEffect, useState, useRef } from 'react';
import { Scale, RefreshCw, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import type { ScaleStatus } from '../types/database';
import type { AutoVisionStatusInfo } from './AutomaticScaleVisionListener';
import { getScaleReading } from '../lib/bridgeApi';
import { playScaleStabilized } from '../lib/sound';

interface ScaleIndicatorProps {
  onWeightStabilized?: (weightGrams: number) => void;
  selectedProductUnit?: string;
  autoVisionStatus?: AutoVisionStatusInfo | null;
}

export const ScaleIndicator: React.FC<ScaleIndicatorProps> = ({
  onWeightStabilized,
  selectedProductUnit = 'kg',
  autoVisionStatus,
}) => {
  const [scaleStatus, setScaleStatus] = useState<ScaleStatus>({
    connected: false,
    weight_grams: null,
    unit: 'g',
    status: 'disconnected',
    port: 'Auto-detecting',
  });
  const [isStable, setIsStable] = useState(false);
  const recentWeightsRef = useRef<number[]>([]);
  const lastStabilizedWeightRef = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true;

    const pollScale = async () => {
      const status = await getScaleReading();
      if (!isMounted) return;

      setScaleStatus(status);

      if (status.connected && status.weight_grams !== null) {
        const w = status.weight_grams;
        const history = recentWeightsRef.current;
        history.push(w);
        if (history.length > 4) history.shift();

        // Check if last 3 readings are within 1.0g stability threshold and > 5g
        if (history.length >= 3) {
          const max = Math.max(...history);
          const min = Math.min(...history);
          const stable = max - min <= 1.0 && w > 5.0;
          setIsStable(stable);

          if (stable && lastStabilizedWeightRef.current !== w) {
            lastStabilizedWeightRef.current = w;
            playScaleStabilized();
            if (onWeightStabilized) {
              onWeightStabilized(w);
            }
          }
        }
      } else {
        setIsStable(false);
        recentWeightsRef.current = [];
      }
    };

    pollScale();
    const interval = setInterval(pollScale, 500);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [onWeightStabilized]);

  const weightGrams = scaleStatus.weight_grams;
  const weightKg = weightGrams !== null ? (weightGrams / 1000).toFixed(3) : '0.000';

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs flex flex-col justify-between">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2.5">
          <div className={`p-2 rounded-xl ${scaleStatus.connected ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'bg-slate-100 text-slate-500'}`}>
            <Scale className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-800 uppercase tracking-wider block">
              Arduino HX711 Scale
            </span>
            <span className="text-[10px] text-slate-400 font-mono">Port: {scaleStatus.port}</span>
          </div>
        </div>

        {/* Status Pill */}
        <div className="flex items-center space-x-1.5">
          {autoVisionStatus && autoVisionStatus.state === 'PROCESSING' ? (
            <span className="inline-flex items-center text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full animate-pulse">
              <Sparkles className="w-3 h-3 mr-1 text-indigo-600" />
              AI Recognizing...
            </span>
          ) : autoVisionStatus && autoVisionStatus.state === 'STABILIZING' ? (
            <span className="inline-flex items-center text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
              <RefreshCw className="w-3 h-3 mr-1 animate-spin text-amber-600" />
              Stabilizing
            </span>
          ) : scaleStatus.status === 'sensor_error' ? (
            <span className="inline-flex items-center text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Sensor Error
            </span>
          ) : scaleStatus.connected && weightGrams !== null ? (
            <span className="inline-flex items-center text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {isStable ? 'Stable' : 'Live'}
            </span>
          ) : (
            <span className="inline-flex items-center text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
              <AlertTriangle className="w-3 h-3 mr-1" />
              {scaleStatus.status}
            </span>
          )}
        </div>
      </div>

      {/* Main Weight Display */}
      <div className="my-2 bg-slate-50 rounded-xl p-3.5 border border-slate-200 text-center">
        {scaleStatus.status === 'sensor_error' ? (
          <div className="py-2 text-rose-700 text-xs flex flex-col items-center justify-center space-y-1">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
            <span className="font-semibold">HX711 Load Cell Error</span>
            <span className="text-[10px] text-rose-600">Check sensor wiring & ready pin</span>
          </div>
        ) : scaleStatus.connected && weightGrams !== null ? (
          <div>
            <div className="text-3xl font-bold font-mono tracking-tight text-slate-900 flex items-baseline justify-center space-x-1">
              <span>{weightGrams.toFixed(1)}</span>
              <span className="text-lg text-indigo-600 font-sans font-medium">g</span>
            </div>
            <div className="text-xs text-slate-500 font-mono mt-0.5">
              = <span className="text-slate-800 font-semibold">{weightKg}</span> {selectedProductUnit}
            </div>
          </div>
        ) : (
          <div className="py-2 text-slate-400 text-xs flex flex-col items-center justify-center space-y-1">
            <RefreshCw className="w-4 h-4 animate-spin text-slate-400" />
            <span>Awaiting scale connection...</span>
          </div>
        )}
      </div>

      {/* Footer Diagnostic Note */}
      <div className="text-[11px] text-slate-500 text-center">
        {autoVisionStatus && autoVisionStatus.message
          ? autoVisionStatus.message
          : scaleStatus.status === 'sensor_error'
            ? '⚠️ Sensor hardware error: check DOUT pin 3 / SCK pin 2'
            : scaleStatus.connected 
              ? (isStable ? '✓ Weight locked • Auto-adding to cart' : 'Place loose produce on scale to recognize automatically') 
              : scaleStatus.detail || (scaleStatus.port && scaleStatus.port !== 'Auto-detecting' ? `Checking connection on ${scaleStatus.port}...` : 'Auto-detecting Arduino USB scale connection...')}
      </div>
    </div>
  );
};
