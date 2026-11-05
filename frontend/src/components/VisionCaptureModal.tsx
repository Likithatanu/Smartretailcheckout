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
  const [analyzing, setAnalyzing] = useState(false);
  const [prediction, setPrediction] = useState<VisionPrediction | null>(null);
  const [matchedProduct, setMatchedProduct] = useState<Product | null>(null);
  const [checkingDb, setCheckingDb] = useState(false);
  const [manualWeightGrams, setManualWeightGrams] = useState<number>(0);
  const [liveScale, setLiveScale] = useState<ScaleStatus>({
    connected: false,
    weight_grams: null,
    unit: 'g',
    status: 'disconnected',
    port: 'COM3',
  });

  // 1. Initialize HTML5 Webcam
  useEffect(() => {
    let mounted = true;

    async function startCamera() {
      // Guard against non-secure context or missing mediaDevices API
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (mounted) {
          setCameraActive(false);
          setCameraError('Browser camera API unavailable. Open via http://localhost:3000 or HTTPS.');
        }
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'environment',
          },
        });
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
      } catch (err: any) {
        console.warn('Webcam getUserMedia failed, fallback to host capture:', err);
        if (mounted) {
          setCameraActive(false);
          let friendlyMsg = 'Browser camera access unavailable. Python bridge will capture host camera.';
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            friendlyMsg = 'Camera permission denied. Please allow camera access in browser settings.';
          } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            friendlyMsg = 'No camera device found on this system.';
          } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            friendlyMsg = 'Camera is in use by another application or process.';
          } else if (err.message) {
            friendlyMsg = err.message;
          }
          setCameraError(friendlyMsg);
        }
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
  }, []);

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

  // 3. Capture Frame and Send to Vision Classifier
  const handleCaptureAndClassify = async () => {
    setAnalyzing(true);
    setPrediction(null);
    setMatchedProduct(null);

    try {
      let imageBlob: Blob | undefined = undefined;

      if (videoRef.current && cameraActive) {
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth || 640;
        canvas.height = videoRef.current.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
          imageBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => (blob ? resolve(blob) : reject(new Error('Canvas blob conversion failed'))),
              'image/jpeg',
              0.85
            );
          });
        }
      }

      // Call bridge prediction
      const result = await predictVision(imageBlob);
      setPrediction(result);
      playVisionChime();

      // Look up real product in Supabase catalog
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
        <div className="flex items-center space-x-3 mb-5">
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
            <p className="text-xs text-slate-500">Place loose grain under camera and on the HX711 scale</p>
          </div>
        </div>

        {/* Camera Viewport & Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Live Camera View */}
          <div className="relative bg-slate-950 rounded-2xl overflow-hidden border border-slate-200 aspect-video md:aspect-square flex items-center justify-center shadow-inner">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className={`w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
            />
            {!cameraActive && (
              <div className="p-4 text-center text-slate-400 text-xs">
                <Camera className="w-8 h-8 mx-auto mb-2 text-slate-500" />
                <span>{cameraError || 'Initializing camera stream...'}</span>
              </div>
            )}

            {/* Target ROI Overlay Guide */}
            <div className="absolute inset-x-8 inset-y-8 border-2 border-dashed border-emerald-400/70 rounded-xl pointer-events-none flex items-center justify-center">
              <span className="text-[10px] uppercase font-mono font-bold bg-slate-900/80 text-emerald-300 px-2 py-0.5 rounded">
                Target Crop Zone
              </span>
            </div>

            {/* Scanning overlay spinner */}
            {analyzing && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex flex-col items-center justify-center text-white space-y-2">
                <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
                <span className="text-xs font-semibold tracking-wide">Classifying grain with PyTorch...</span>
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

            {/* Capture Button */}
            <button
              onClick={handleCaptureAndClassify}
              disabled={analyzing}
              className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm shadow-xs flex items-center justify-center space-x-2 transition-all disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>{analyzing ? 'Analyzing Frame...' : 'Capture & Identify'}</span>
            </button>

            {/* AI Prediction Card */}
            {prediction && (
              <div className="bg-slate-50 p-4 rounded-2xl border border-indigo-200 space-y-3">
                <div>
                  <div className="text-[10px] uppercase font-bold text-indigo-700 tracking-wider">
                    Model Prediction
                  </div>
                  <div className="text-base font-bold text-slate-900 mt-0.5">
                    {getFriendlyClassName(prediction.predicted_class)}
                  </div>
                  <div className="text-xs text-slate-500 flex items-center space-x-2 mt-0.5">
                    <span>Confidence: {(prediction.confidence * 100).toFixed(1)}%</span>
                    <span>•</span>
                    <span className="font-mono text-[10px]">{prediction.model_version}</span>
                  </div>
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
