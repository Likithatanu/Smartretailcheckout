import type { BridgeHealth, ScaleStatus, VisionPrediction } from '../types/database';

const BRIDGE_BASE_URL = import.meta.env.VITE_LOCAL_BRIDGE_URL || 'http://127.0.0.1:8000';

/**
 * Check health status of local bridge, model checkpoints, and serial hardware.
 */
export async function getBridgeHealth(): Promise<BridgeHealth> {
  try {
    const res = await fetch(`${BRIDGE_BASE_URL}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Bridge returned HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err: any) {
    return {
      status: 'degraded',
      api_running: false,
      model_loaded: false,
      serial_connected: false,
      serial_port: 'COM3',
      camera_available: false,
      active_model_version: 'v2',
      available_model_versions: ['v1', 'v2'],
    };
  }
}

/**
 * Poll live scale weight reading in grams from the Arduino HX711 load cell.
 */
export async function getScaleReading(): Promise<ScaleStatus> {
  try {
    const res = await fetch(`${BRIDGE_BASE_URL}/scale`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Scale endpoint returned HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err: any) {
    return {
      connected: false,
      weight_grams: null,
      unit: 'g',
      status: 'disconnected',
      port: 'COM3',
      detail: err.message || 'Cannot reach local scale bridge',
    };
  }
}

/**
 * Convert a Blob / File to base64 string.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Request real-time vision classification from bridge.
 * Supports direct host camera capture or uploading a captured frame blob from browser.
 */
export async function predictVision(imageBlob?: Blob): Promise<VisionPrediction> {
  let url = `${BRIDGE_BASE_URL}/vision/predict`;
  let options: RequestInit;

  if (imageBlob) {
    const base64Data = await blobToBase64(imageBlob);
    options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ image_base64: base64Data }),
    };
  } else {
    // Host webcam capture via GET /vision/predict
    options = {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(errBody.detail || `Vision prediction failed with status ${res.status}`);
  }

  return await res.json();
}
