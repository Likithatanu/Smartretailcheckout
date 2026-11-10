"""FastAPI application for the local hardware and AI bridge.

Endpoints:
- GET /health: Health status, model loading, and verified serial connection.
- GET /scale: Real load-cell weight reading in grams and connection status.
- GET /vision/predict: Real camera capture and ConvNeXt-Tiny classification.
- GET /vision/model: Status of active and available model checkpoints (v1 / v2).
- POST /vision/model: Switch active model checkpoint between v1 and v2.
- GET /vision/roi: Current Region of Interest (ROI) configuration.

Binds to 127.0.0.1:8000 by default.
"""
import asyncio
from contextlib import asynccontextmanager
import base64
import io
import logging
from typing import AsyncGenerator, Optional

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
from PIL import Image
import uvicorn

from local_bridge import config
from local_bridge.camera_manager import (
    CameraCaptureError,
    CameraManager,
    CameraUnavailableError,
)
from local_bridge.model_loader import (
    InvalidRoiError,
    ModelInferenceError,
    ModelLoadError,
    VisionClassifier,
)
from local_bridge.scale_reader import ScaleReader
from local_bridge.schemas import (
    HealthResponse,
    ModelStatusResponse,
    ModelSwitchRequest,
    RoiConfigResponse,
    ScaleResponse,
    VisionPredictionResponse,
    VisionPredictRequest,
)

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("local_bridge")

# Global singleton component instances
scale_reader = ScaleReader(
    port=config.DEFAULT_SERIAL_PORT,
    baudrate=config.DEFAULT_BAUD_RATE,
    timeout=config.SERIAL_TIMEOUT_SECONDS,
    retry_interval=config.SERIAL_RETRY_INTERVAL_SECONDS,
)

camera_manager = CameraManager(
    camera_index=config.DEFAULT_CAMERA_INDEX,
)

classifier = VisionClassifier(
    v1_path=config.MODEL_V1_PATH,
    v2_path=config.MODEL_V2_PATH,
    active_version=config.DEFAULT_MODEL_VERSION,
    confidence_threshold=config.CONFIDENCE_THRESHOLD,
    device_name="cpu",
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Safe lifecycle management for hardware interfaces and model resources."""
    logger.info("Initializing Local Hardware & AI Bridge on %s:%d...", config.HOST, config.PORT)

    # 1. Start background scale polling thread
    try:
        scale_reader.start()
    except Exception as exc:
        logger.error("Failed to start scale reader thread: %s", exc)

    # 2. Load PyTorch model checkpoint
    try:
        classifier.load()
    except ModelLoadError as exc:
        logger.error("Vision model failed to load during startup: %s", exc)

    yield

    # Clean shutdown of serial port and camera device
    logger.info("Shutting down Local Hardware & AI Bridge...")
    scale_reader.stop()
    camera_manager.release()
    logger.info("Hardware handles cleanly released.")


app = FastAPI(
    title="AI Smart Retail Checkout — Local Bridge",
    description="Local hardware interface for Arduino HX711 scale and ConvNeXt-Tiny webcam vision.",
    version="0.2.0",
    lifespan=lifespan,
)

# CORS middleware enabling browser frontend (http://localhost:3000) to communicate with bridge
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse, tags=["Diagnostics"])
async def get_health() -> HealthResponse:
    """Report real-time health and verified hardware connectivity.

    Does not report a device as connected unless the connection
    was actually verified.
    """
    model_loaded = classifier.is_loaded
    serial_connected = scale_reader.is_connected()
    camera_available = camera_manager.check_availability()

    is_healthy = model_loaded and serial_connected
    overall_status = "ok" if is_healthy else "degraded"

    return HealthResponse(
        status=overall_status,
        api_running=True,
        model_loaded=model_loaded,
        model_name=classifier.model_name if model_loaded else None,
        classes=classifier.get_classes() if model_loaded else None,
        serial_connected=serial_connected,
        serial_port=scale_reader.port,
        camera_available=camera_available,
        active_model_version=classifier.active_version,
        available_model_versions=["v1", "v2"],
    )


@app.get("/scale", response_model=ScaleResponse, tags=["Hardware"])
async def get_scale() -> ScaleResponse:
    """Retrieve the latest real weight reading from the calibrated scale.

    Parses live Arduino HX711 serial output.
    Never fabricates weight readings when disconnected.
    """
    return scale_reader.get_reading()


@app.get("/vision/model", response_model=ModelStatusResponse, tags=["Vision", "Model Management"])
async def get_model_status() -> ModelStatusResponse:
    """Retrieve current vision model status, active candidate, and file paths."""
    return ModelStatusResponse(
        active_version=classifier.active_version,
        available_versions=["v1", "v2"],
        v1_loaded=classifier.is_version_loaded("v1"),
        v2_loaded=classifier.is_version_loaded("v2"),
        v1_path=str(classifier.v1_path),
        v2_path=str(classifier.v2_path),
        confidence_threshold=classifier.confidence_threshold,
    )


@app.post("/vision/model", response_model=ModelStatusResponse, tags=["Vision", "Model Management"])
async def switch_model(payload: ModelSwitchRequest) -> ModelStatusResponse:
    """Switch active vision model between 'v1' (baseline) and 'v2' (fine-tuned)."""
    target = payload.version.lower().strip()
    if target not in ("v1", "v2"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model version '{payload.version}'. Supported versions are 'v1' and 'v2'.",
        )
    try:
        classifier.switch_version(target)
        logger.info("Successfully switched active vision model to '%s'.", target)
    except ModelLoadError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load model '{target}': {exc}",
        )
    return await get_model_status()


@app.get(
    "/vision/predict",
    response_model=VisionPredictionResponse,
    responses={
        400: {"description": "Invalid ROI crop bounds or frame dimensions"},
        500: {"description": "Vision inference failed"},
        503: {"description": "Camera unavailable or capture failed"},
    },
    tags=["Vision"],
)
async def predict_vision(
    version: Optional[str] = Query(None, pattern="^(v1|v2)$", description="Optional model version override")
) -> VisionPredictionResponse:
    """Capture a real webcam frame, crop configured ROI, and classify grain product.

    Returns the top predicted class, all 3 class probabilities, confidence, model version, and crop diagnostics.
    If ROI bounds are invalid or the frame is too small, returns an explicit 400 error.
    If the camera or model fails, returns an explicit 503 error rather than a fake prediction.
    """
    if not classifier.is_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Vision model is not loaded. Check model checkpoint path and server logs.",
        )

    # 1. Capture real frame non-blockingly
    try:
        frame_rgb = camera_manager.capture_frame()
    except CameraUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Camera unavailable: {exc}",
        )
    except CameraCaptureError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Camera capture error: {exc}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Unexpected camera error: {exc}",
        )

    # 2. Determine ROI crop bounds
    roi_bounds = (
        (
            config.DEFAULT_ROI_X_MIN,
            config.DEFAULT_ROI_Y_MIN,
            config.DEFAULT_ROI_X_MAX,
            config.DEFAULT_ROI_Y_MAX,
        )
        if config.ROI_ENABLED
        else None
    )

    # 3. Run model inference on cropped frame
    try:
        prediction = classifier.predict(frame_rgb, roi_bounds, version)
        return prediction
    except InvalidRoiError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"ROI crop validation failed: {exc}",
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model inference timed out after {config.INFERENCE_TIMEOUT_SECONDS} seconds.",
        )
    except ModelInferenceError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model inference failed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected model inference error: {exc}",
        )


@app.post(
    "/vision/predict",
    response_model=VisionPredictionResponse,
    responses={
        400: {"description": "Invalid image payload, ROI crop bounds, or frame dimensions"},
        500: {"description": "Vision inference failed"},
        503: {"description": "Model not loaded or camera unavailable"},
    },
    tags=["Vision"],
)
async def predict_vision_post(
    payload: Optional[VisionPredictRequest] = None,
) -> VisionPredictionResponse:
    """Classify grain product from an uploaded webcam frame or live camera capture.

    Accepts base64-encoded JPEG/PNG frame in JSON payload, or falls back
    to capturing a frame from host camera if no image is provided.
    """
    if not classifier.is_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Vision model is not loaded. Check model checkpoint path and server logs.",
        )

    version_override = payload.version if payload else None

    if payload and payload.image_base64:
        try:
            b64_data = payload.image_base64
            # Strip data:image/...;base64, header if present
            if "," in b64_data:
                b64_data = b64_data.split(",", 1)[1]
            image_bytes = base64.b64decode(b64_data)
            pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            frame_rgb = np.array(pil_img)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not parse base64 image data: {exc}",
            )
    else:
        # Fall back to host camera capture
        try:
            frame_rgb = camera_manager.capture_frame()
        except CameraUnavailableError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Camera unavailable: {exc}",
            )
        except CameraCaptureError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Camera capture error: {exc}",
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Unexpected camera error: {exc}",
            )

    # Apply ROI crop bounds if enabled (unless caller explicitly pre-cropped to target zone)
    use_roi = (
        payload.apply_roi
        if (payload is not None and payload.apply_roi is not None)
        else config.ROI_ENABLED
    )
    roi_bounds = (
        (
            config.DEFAULT_ROI_X_MIN,
            config.DEFAULT_ROI_Y_MIN,
            config.DEFAULT_ROI_X_MAX,
            config.DEFAULT_ROI_Y_MAX,
        )
        if use_roi
        else None
    )

    try:
        prediction = classifier.predict(frame_rgb, roi_bounds, version_override)
        return prediction
    except InvalidRoiError:
        # If ROI crop fails on user image (e.g. non-standard resolution), retry on full uncropped image
        try:
            return classifier.predict(frame_rgb, None, version_override)
        except Exception as inner_exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Inference failed on frame: {inner_exc}",
            )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model inference timed out after {config.INFERENCE_TIMEOUT_SECONDS} seconds.",
        )
    except ModelInferenceError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model inference failed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected model inference error: {exc}",
        )


@app.get("/vision/roi", response_model=RoiConfigResponse, tags=["Vision", "Diagnostics"])
async def get_roi_config() -> RoiConfigResponse:
    """Report the current Region of Interest (ROI) crop parameters."""
    return RoiConfigResponse(
        enabled=config.ROI_ENABLED,
        x_min=config.DEFAULT_ROI_X_MIN,
        y_min=config.DEFAULT_ROI_Y_MIN,
        x_max=config.DEFAULT_ROI_X_MAX,
        y_max=config.DEFAULT_ROI_Y_MAX,
        description=(
            f"ROI cropping is {'enabled' if config.ROI_ENABLED else 'disabled'}. "
            f"Crop box: x={config.DEFAULT_ROI_X_MIN}..{config.DEFAULT_ROI_X_MAX}, "
            f"y={config.DEFAULT_ROI_Y_MIN}..{config.DEFAULT_ROI_Y_MAX}."
        ),
    )


if __name__ == "__main__":
    uvicorn.run(
        "local_bridge.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
        reload=False,
    )
