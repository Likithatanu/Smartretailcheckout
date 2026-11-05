# AI Smart Retail Checkout — Phase 2 Local Bridge

A local Python FastAPI bridge that connects checkout hardware (Arduino HX711 load cell scale, laptop webcam) and the PyTorch ConvNeXt-Tiny vision classification model to the checkout application.

---

## 1. System Capabilities & Design

1. **`GET /health`**:
   - Reports whether the FastAPI server is running.
   - Reports whether the vision model checkpoint is loaded.
   - Reports whether the Arduino serial device is actively communicating.
   - **Strict Guarantee**: Never reports hardware as connected unless physical communication is actively verified.

2. **`GET /scale`**:
   - Returns the latest real load cell reading in grams parsed from the Arduino HX711 serial output.
   - Expected Arduino serial format: `Weight: <float> g` (e.g., `Weight: 142.50 g` or `Weight: 0.00 g`).
   - If the device is disconnected or awaiting data, reports `connected: false` and `weight_grams: null`.
   - **Strict Guarantee**: Never fabricates synthetic weight readings.

3. **`GET /vision/predict`**:
   - Captures a real RGB video frame from the laptop webcam.
   - Runs inference through the trained **ConvNeXt-Tiny** PyTorch model.
   - Returns the predicted product class (`chana_dal`, `masur_dal`, or `rice`), confidence score, and complete 3-class probability distribution.
   - If the camera device is unavailable or capture fails, returns an HTTP 503 error with diagnostic details.
   - **Strict Guarantee**: Never fabricates synthetic predictions on camera failure.

4. **Non-Blocking Architecture & Concurrency**:
   - Serial communication runs in a dedicated background worker thread (`ScaleReader`), polling non-blockingly and updating thread-safe memory state under mutex lock.
   - Model inference and camera frame capture are executed via `asyncio.to_thread` with sensible timeouts to prevent blocking the async event loop.
   - Camera device lifecycle is strictly managed to prevent competing device handles.

5. **Security & Isolation**:
   - Default binding is restricted strictly to loopback: `127.0.0.1:8000`.
   - Not exposed to the LAN or public internet.

---

## 2. Directory Structure

```text
local_bridge/
├── __init__.py           # Package marker
├── config.py             # Environment configuration with sensible defaults
├── schemas.py            # Pydantic response models
├── scale_reader.py       # Serial connection worker and Arduino output parser
├── camera_manager.py     # Safe webcam lifecycle and frame capture
├── model_loader.py       # PyTorch ConvNeXt-Tiny model loader & inference
├── main.py               # FastAPI application with lifespan management
├── requirements.txt      # Python package requirements
├── README.md             # Setup and operational documentation
└── tests/                # Automated mock test suite (no physical devices needed)
    ├── __init__.py
    ├── test_health.py    # Health diagnostics and scale endpoint tests
    ├── test_scale.py     # String parsing and mocked serial worker tests
    └── test_vision.py    # Camera failure handling and model inference tests
```

---

## 3. Configuration

Configurable via environment variables (with default fallbacks):

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `SCALE_SERIAL_PORT` | `COM3` | Serial port name for Arduino Uno |
| `SCALE_BAUD_RATE` | `9600` | Baud rate for serial communication |
| `SCALE_SERIAL_TIMEOUT` | `1.0` | Serial read timeout in seconds |
| `MODEL_CHECKPOINT_PATH` | `D:\smart-retailmodeltraining\checkpoints_new\convnext_tiny_3class_v1.pth` | Path to PyTorch model checkpoint |
| `CAMERA_INDEX` | `0` | OpenCV video capture device index |
| `CAMERA_TIMEOUT` | `3.0` | Max seconds to wait for webcam capture |
| `INFERENCE_TIMEOUT` | `5.0` | Max seconds to wait for model inference |
| `ROI_ENABLED` | `true` | Enable or disable Region of Interest cropping |
| `ROI_CROP_X_MIN` | `140` | Left X boundary for 640x480 frame ROI |
| `ROI_CROP_Y_MIN` | `200` | Top Y boundary for 640x480 frame ROI |
| `ROI_CROP_X_MAX` | `500` | Right X boundary for 640x480 frame ROI |
| `ROI_CROP_Y_MAX` | `480` | Bottom Y boundary for 640x480 frame ROI |
| `LOCAL_BRIDGE_HOST` | `127.0.0.1` | Local bind IP address |
| `LOCAL_BRIDGE_PORT` | `8000` | Local bind port |

---

## 4. Windows PowerShell Commands

Execute all commands from the repository root:
`c:\Users\likit\OneDrive\Desktop\smartretailecheckout`

### A. Run Automated Unit Tests
Uses the existing Python virtual environment (`D:\smart-retailmodeltraining\.venv`):

```powershell
& "D:\smart-retailmodeltraining\.venv\Scripts\python.exe" -m pytest local_bridge\tests -v
```

### B. Start the Local Bridge Service

```powershell
& "D:\smart-retailmodeltraining\.venv\Scripts\python.exe" -m uvicorn local_bridge.main:app --host 127.0.0.1 --port 8000
```

### C. Verify API Endpoints (in a separate PowerShell terminal)

1. **Check Service Health:**
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" | ConvertTo-Json
```

2. **Read Scale Measurement:**
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/scale" | ConvertTo-Json
```

3. **Inspect ROI Crop Parameters (Diagnostic):**
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/vision/roi" | ConvertTo-Json
```

4. **Capture Webcam & Classify Grain (with ROI Applied):**
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/vision/predict" | ConvertTo-Json
```

---

## 5. Troubleshooting & Hardware Notes

- **Arduino `Access is denied` (COM3):**
  If `COM3` reports access denied, ensure the **Arduino IDE Serial Monitor** or any other serial terminal (PuTTY, screen) is closed, as Windows enforces exclusive serial port locks.
- **Webcam Access:**
  Ensure the camera is not actively in use by another application (Zoom, Teams, Camera app) and Windows Camera privacy permissions permit desktop application access.
