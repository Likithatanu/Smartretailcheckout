import React, { useState, useRef, useEffect } from 'react';
import { 
  X, 
  Camera, 
  Sparkles, 
  Scale, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  PlusCircle, 
  RotateCcw,
} from 'lucide-react';
import type { Product, CartItem, VisionPrediction, ScaleStatus } from '../types/database';
import { predictVision, getScaleReading } from '../lib/bridgeApi';
import { getProductByModelClass } from '../lib/supabase';
import { playVisionChime, playErrorAlert } from '../lib/sound';

interface VisionCaptureModalProps {
  storeId: string;
  onClose: () => void;
  onAddToCart: (item: CartItem) => void;
  onOpenAddProductModal: (prefillModelClass: string) => void;
}

export const VisionCaptureModal: React.FC<VisionCaptureModalProps> = ({
  storeId,
  onClose,
  onAddToCart,
  onOpenAddProductModal,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraRetryKey, setCameraRetryKey] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [prediction, setPrediction] = useState<VisionPrediction | null>(null);
  const [matchedProduct, setMatchedProduct] = useState<Product | null>(null);
  const [checkingDb, setCheckingDb] = useState(false);
  const [manualWeightGrams, setManualWeightGrams] = useState<number>(0);
  const [capturedSnapshot, setCapturedSnapshot] = useState<string | null>(null);
  const [selectedModelVersion, setSelectedModelVersion] = useState<'v1' | 'v2'>('v2');
  const [liveScale, setLiveScale] = useState<ScaleStatus>({
    connected: false,
    weight_grams: null,
    unit: 'g',
    status: 'disconnected',
    port: 'Auto',
  });

  // 1. Initialize HTML5 Webcam with automatic Windows driver release retry
  useEffect(() => {
    let mounted = true;

    async function startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (mounted) {
          setCameraActive(false);
          setCameraError('Browser camera API unavailable. Open via http://localhost:3000 or HTTPS.');
        }
        return;
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (mounted) {
        setCameraError(null);
      }

      const constraintCandidates: MediaStreamConstraints[] = [
        { video: { width: { ideal: 640 }, height: { ideal: 480 } } },
        { video: true },
        { video: { width: { ideal: 640 }, height: { ideal: 480 } } },
        { video: true },
      ];

      let lastErr: any = null;
      for (let attempt = 0; attempt < constraintCandidates.length; attempt++) {
        if (!mounted) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraintCandidates[attempt]);
          if (!mounted) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            try {
              await videoRef.current.play();
            } catch (playErr) {
              console.warn('Initial video play failed:', playErr);
            }
          }
          setCameraActive(true);
          setCameraError(null);
          return;
        } catch (err: any) {
          lastErr = err;
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            break;
          }
          // Wait briefly for Windows DirectShow / MediaFoundation handle release before retrying
          await new Promise((r) => setTimeout(r, 450));
        }
      }

      console.warn('Webcam getUserMedia failed, fallback to host capture:', lastErr);
      if (mounted && lastErr) {
        setCameraActive(false);
        let friendlyMsg = 'Browser camera access unavailable. Python bridge will capture host camera.';
        if (lastErr.name === 'NotAllowedError' || lastErr.name === 'PermissionDeniedError') {
          friendlyMsg = 'Camera permission denied. Please allow camera access in browser settings.';
        } else if (lastErr.name === 'NotFoundError' || lastErr.name === 'DevicesNotFoundError') {
          friendlyMsg = 'No camera device found on this system.';
        } else if (lastErr.name === 'NotReadableError' || lastErr.name === 'TrackStartError') {
          friendlyMsg = 'Camera is busy in another window/app. Close other camera tabs or click Retry.';
        } else if (lastErr.message) {
          friendlyMsg = lastErr.message;
        }
        setCameraError(friendlyMsg);
      }
    }

    startCamera();

    // 2. Poll live scale weight
    const scaleInterval = setInterval(async () => {
      if (!mounted) return;
      const reading = await getScaleReading();
      setLiveScale(reading);
      if (reading.connected && reading.status === 'connected' && reading.weight_grams !== null && reading.weight_grams > 0) {
        setManualWeightGrams(reading.weight_grams);
      }
    }, 500);

    return () => {
      mounted = false;
      clearInterval(scaleInterval);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [cameraRetryKey]);

  // Synchronize stream attachment to video DOM element whenever stream or active state changes
  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch((err) => {
        console.warn('Video playback sync failed:', err);
      });
    }
  }, [cameraActive]);

  // Pricing based on weighed quantity
  const isSensorError = liveScale.status === 'sensor_error';
  const activeWeightGrams = isSensorError
    ? 0
    : (liveScale.connected && liveScale.weight_grams !== null && liveScale.weight_grams > 0
        ? liveScale.weight_grams
        : manualWeightGrams);
  const weightKg = Number((activeWeightGrams / 1000).toFixed(3));
  const unitPrice = matchedProduct?.price_per_unit || 0;
  const taxRate = matchedProduct?.tax_rate_percent || 0;

  const baseSubtotal = Number((unitPrice * weightKg).toFixed(2));
  const taxAmount = Number(((baseSubtotal * taxRate) / 100).toFixed(2));
  const itemTotal = Number((baseSubtotal + taxAmount).toFixed(2));

  // 3. Manual Capture Frame and Send to Vision Classifier (triggered ONLY by user click)
  const handleCaptureAndClassify = async () => {
    if (activeWeightGrams <= 5.0) {
      playErrorAlert();
      alert(
        "Please place loose grain (e.g. Rice, Chana Dal, or Masur Dal) on the HX711 scale first.\n\n" +
        "Current weight is 0.0g. Camera classification requires weighed produce on the platform to prevent misclassifying background or people."
      );
      return;
    }

    setAnalyzing(true);
    setPrediction(null);
    setMatchedProduct(null);

    try {
      let imageBlob: Blob | undefined = undefined;

      if (videoRef.current && cameraActive) {
        const vw = videoRef.current.videoWidth || 640;
        const vh = videoRef.current.videoHeight || 480;
        // Exact WYSIWYG crop matching the green Target Produce Zone overlay (left 16%, top 24%, 68% x 68%)
        const sx = Math.round(vw * 0.16);
        const sy = Math.round(vh * 0.24);
        const sw = Math.round(vw * 0.68);
        const sh = Math.round(vh * 0.68);

        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, sx, sy, sw, sh, 0, 0, sw, sh);
          setCapturedSnapshot(canvas.toDataURL('image/jpeg', 0.9));
          imageBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => (blob ? resolve(blob) : reject(new Error('Canvas blob conversion failed'))),
              'image/jpeg',
              0.9
            );
          });
        }
      }

      // Call bridge prediction with pre-cropped target zone (applyRoi = false prevents hidden double-cropping)
      const result = await predictVision(imageBlob, selectedModelVersion, imageBlob ? false : undefined);
      setPrediction(result);

      // Reject non-grain objects (faces, hands, phones, packets, empty background) or low-confidence views
      if (result.is_ood || !result.is_confident) {
        playErrorAlert();
        setMatchedProduct(null);
        return;
      }

      playVisionChime();

      // Look up real product in Supabase catalog ONLY when verified as loose grain
      setCheckingDb(true);
      const product = await getProductByModelClass(storeId, result.predicted_class);
      setMatchedProduct(product);
      setCheckingDb(false);
    } catch (err: any) {
      console.error('Vision classification error:', err);
      playErrorAlert();
      alert(`AI Vision Error: ${err.message || 'Failed to classify loose item.'}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRecapture = () => {
    setCapturedSnapshot(null);
    setPrediction(null);
    setMatchedProduct(null);
  };

  const handleConfirmAddToCart = () => {
    if (!matchedProduct) return;
    if (isSensorError) {
      alert('Scale sensor error reported: HX711 not ready. Please verify scale hardware before adding weighed item.');
      return;
    }
    if (weightKg <= 0) {
      alert('Please place loose product on the scale to read weight before adding to cart.');
      return;
    }

    onAddToCart({
      product: matchedProduct,
      quantity_or_weight: weightKg,
      base_subtotal: baseSubtotal,
      tax_amount: taxAmount,
      item_total: itemTotal,
      detection_source: 'ai_camera',
      confidence: prediction?.confidence,
      weight_grams: activeWeightGrams,
    });

    onClose();
  };

  const getFriendlyClassName = (cls: string) => {
    switch (cls) {
      case 'chana_dal': return 'Chana Dal (Bengal Gram)';
      case 'masur_dal': return 'Masur Dal (Red Lentil)';
      case 'rice': return 'Rice (Loose Grains)';
      default: return cls;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-2xl p-6 shadow-xl relative max-h-[95vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center space-x-2">
                <span>AI Camera Recognition</span>
                <span className="text-[10px] font-semibold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-100">
                  ConvNeXt-Tiny
                </span>
              </h2>
              <p className="text-xs text-slate-500">Place loose grain on the scale and frame under camera</p>
            </div>
          </div>

          {/* Model Version Selector */}
          <div className="flex items-center space-x-2 mr-8">
            <span className="text-xs font-medium text-slate-500">Model:</span>
            <select
              value={selectedModelVersion}
              onChange={(e) => setSelectedModelVersion(e.target.value as 'v1' | 'v2')}
              className="text-xs bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg px-2 py-1 font-semibold text-slate-700 cursor-pointer focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            >
              <option value="v1">v1 (Balanced)</option>
              <option value="v2">v2 (Fine-Tuned)</option>
            </select>
          </div>
        </div>

        {/* Camera Viewport & Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col space-y-2">
            {/* Live Camera View (True 4:3 matching 640x480 sensor so ROI box is 100% WYSIWYG) */}
            <div className="relative bg-slate-950 rounded-2xl overflow-hidden border border-slate-200 aspect-[4/3] flex items-center justify-center shadow-inner">
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className={`w-full h-full object-fill ${cameraActive ? 'block' : 'hidden'}`}
              />
              {!cameraActive && (
                <div className="p-4 text-center text-slate-300 text-xs z-10 flex flex-col items-center space-y-2.5">
                  <Camera className="w-8 h-8 mx-auto text-slate-400" />
                  <span>{cameraError || 'Initializing camera stream...'}</span>
                  {cameraError && (
                    <button
                      type="button"
                      onClick={() => setCameraRetryKey((k) => k + 1)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center space-x-1.5 shadow-xs transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry Camera</span>
                    </button>
                  )}
                </div>
              )}

              {/* Exact WYSIWYG Target ROI Overlay Guide (left 16%, top 24%, width 68%, height 68%) */}
              <div
                style={{
                  left: '16%',
                  top: '24%',
                  width: '68%',
                  height: '68%',
                  boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.42)',
                }}
                className="absolute border-2 border-dashed border-emerald-400/85 rounded-xl pointer-events-none flex items-start justify-center pt-2"
              >
                <span className="text-[10px] uppercase font-mono font-bold bg-slate-900/85 text-emerald-300 px-2 py-0.5 rounded shadow-xs">
                  Place / Hold Grain Inside Box
                </span>
              </div>

              {/* Scanning overlay spinner */}
              {analyzing && (
                <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex flex-col items-center justify-center text-white space-y-2 z-20">
                  <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
                  <span className="text-xs font-semibold tracking-wide">Classifying grain with ConvNeXt ({selectedModelVersion})...</span>
                </div>
              )}
            </div>

            {/* Captured Snapshot Preview */}
            {capturedSnapshot && (
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center space-x-3">
                <img
                  src={capturedSnapshot}
                  alt="Captured snapshot"
                  className="w-16 h-12 object-cover rounded-lg border border-slate-300 shadow-xs flex-shrink-0"
                />
                <div className="text-xs text-slate-600">
                  <span className="font-semibold block text-slate-800">Captured Frame</span>
                  <span className="text-[11px] text-slate-500">Image submitted to PyTorch model</span>
                </div>
              </div>
            )}
          </div>

          {/* Scale & Prediction Panel */}
          <div className="flex flex-col justify-between space-y-4">
            {/* Live HX711 Weight Widget */}
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center space-x-1">
                  <Scale className="w-3.5 h-3.5 text-indigo-600" />
                  <span>HX711 Live Scale</span>
                </span>
                <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${
                  isSensorError
                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                    : liveScale.connected && liveScale.weight_grams !== null
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-amber-50 text-amber-700 border border-amber-200'
                }`}>
                  {isSensorError
                    ? 'Sensor Error'
                    : liveScale.connected && liveScale.weight_grams !== null
                      ? 'Scale Live'
                      : 'Manual Mode'}
                </span>
              </div>

              {isSensorError ? (
                <div className="py-2.5 px-3 my-1 rounded-xl bg-rose-50 border border-rose-200 text-center">
                  <div className="flex items-center justify-center space-x-1.5 text-rose-700 text-xs font-semibold">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>HX711 Hardware Not Ready</span>
                  </div>
                  <p className="text-[10px] text-rose-600 mt-0.5">Check load cell wiring (pin 3 DOUT, pin 2 SCK)</p>
                </div>
              ) : (
                <div className="text-2xl font-bold font-mono text-slate-900 text-center py-1">
                  {activeWeightGrams.toFixed(1)} <span className="text-indigo-600 text-base font-sans">g</span>
                  <span className="text-xs text-slate-500 ml-2 font-mono">({weightKg.toFixed(3)} kg)</span>
                </div>
              )}

              {/* Optional manual weight slider if physical scale is not yet attached */}
              {!liveScale.connected && !isSensorError && (
                <div className="mt-2 pt-2 border-t border-slate-200">
                  <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                    <span>Simulated Test Weight:</span>
                    <span className="font-mono text-slate-700">{activeWeightGrams} g</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="1000"
                    step="10"
                    value={manualWeightGrams}
                    onChange={(e) => setManualWeightGrams(Number(e.target.value))}
                    className="w-full accent-indigo-600 h-1 bg-slate-200 rounded-lg cursor-pointer"
                  />
                </div>
              )}
            </div>

            {/* Weighing guidance note */}
            {activeWeightGrams <= 5.0 && !isSensorError && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-xl flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span>Place loose grain on the scale (&gt; 5g) before identifying to prevent false positives.</span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex space-x-2">
              <button
                onClick={handleCaptureAndClassify}
                disabled={analyzing}
                className="flex-1 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm shadow-xs flex items-center justify-center space-x-2 transition-all disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                <span>{analyzing ? 'Analyzing Frame...' : 'Capture & Identify'}</span>
              </button>

              {prediction && (
                <button
                  type="button"
                  onClick={handleRecapture}
                  disabled={analyzing}
                  title="Scan another loose grain"
                  className="py-3 px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs flex items-center space-x-1.5 transition-colors border border-slate-200"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Rescan</span>
                </button>
              )}
            </div>

            {/* AI Prediction / Open-Set Rejection Card */}
            {prediction && (
              prediction.is_ood || !prediction.is_confident ? (
                <div className="bg-rose-50/70 p-4 rounded-2xl border border-rose-200 space-y-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] uppercase font-bold text-rose-700 tracking-wider">
                        Grain Verification Check
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-rose-100 text-rose-800 border-rose-200">
                        {prediction.is_ood ? 'Rejected — Not Loose Grain' : 'Low Confidence'}
                      </span>
                    </div>
                    <div className="text-base font-bold text-rose-950 mt-1 flex items-center space-x-1.5">
                      <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                      <span>No Loose Grain Detected</span>
                    </div>
                    <p className="text-xs text-rose-800 mt-1.5 leading-relaxed">
                      {prediction.rejection_reason ||
                        'Camera sees a face, hand, packet, or background instead of loose produce. Place loose Rice, Chana Dal, or Masur Dal inside the green box and click Rescan.'}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleRecapture}
                    className="w-full py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs flex items-center justify-center space-x-1.5 transition-colors shadow-xs"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Rescan Loose Grain</span>
                  </button>
                </div>
              ) : (
                <div className="bg-slate-50 p-4 rounded-2xl border border-indigo-200 space-y-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] uppercase font-bold text-indigo-700 tracking-wider">
                        Model Prediction
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                        Verified Grain
                      </span>
                    </div>
                    <div className="text-base font-bold text-slate-900 mt-0.5">
                      {getFriendlyClassName(prediction.predicted_class)}
                    </div>
                    <div className="text-xs text-slate-500 flex items-center space-x-2 mt-0.5">
                      <span>Confidence: {(prediction.confidence * 100).toFixed(1)}%</span>
                      <span>•</span>
                      <span className="font-mono text-[10px]">{prediction.model_version}</span>
                    </div>

                    {/* Per-class probability breakdown */}
                    {prediction.probabilities && (
                      <div className="mt-2.5 space-y-1 pt-2 border-t border-slate-200/80">
                        {(['chana_dal', 'masur_dal', 'rice'] as const).map((clsKey) => {
                          const pct = Math.round((prediction.probabilities[clsKey] || 0) * 100);
                          return (
                            <div key={clsKey} className="flex items-center text-[11px] space-x-2">
                              <span className="w-20 text-slate-600 truncate font-medium">
                                {clsKey === 'chana_dal' ? 'Chana Dal' : clsKey === 'masur_dal' ? 'Masur Dal' : 'Rice'}
                              </span>
                              <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    clsKey === prediction.predicted_class ? 'bg-indigo-600' : 'bg-slate-400'
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="w-8 text-right font-mono text-slate-700">{pct}%</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Database Catalog Match Status */}
                  {checkingDb ? (
                    <div className="text-xs text-slate-500 flex items-center space-x-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Verifying in store catalog...</span>
                    </div>
                  ) : matchedProduct ? (
                    <div className="pt-2 border-t border-slate-200 space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Catalog Product:</span>
                        <span className="font-semibold text-slate-800">{matchedProduct.name}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Unit Price:</span>
                        <span className="font-mono text-slate-800">₹{matchedProduct.price_per_unit.toFixed(2)} / {matchedProduct.unit}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Calculated Total ({weightKg} kg):</span>
                        <span className="font-mono font-bold text-indigo-600 text-sm">₹{itemTotal.toFixed(2)}</span>
                      </div>

                      <button
                        onClick={handleConfirmAddToCart}
                        disabled={weightKg <= 0 || isSensorError}
                        className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Confirm & Add to Cart</span>
                      </button>
                    </div>
                  ) : (
                    <div className="pt-2 border-t border-slate-200">
                      <div className="text-xs text-amber-800 flex items-start space-x-1.5 mb-2 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                        <span>AI recognized '{prediction.predicted_class}', but this product is not registered in your store catalog.</span>
                      </div>
                      <button
                        onClick={() => {
                          onClose();
                          onOpenAddProductModal(prediction.predicted_class);
                        }}
                        className="w-full py-2 px-3 rounded-xl bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-semibold text-xs flex items-center justify-center space-x-1.5 transition-colors"
                      >
                        <PlusCircle className="w-4 h-4" />
                        <span>Add '{prediction.predicted_class}' to Catalog</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
