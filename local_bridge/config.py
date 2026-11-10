"""Configuration settings for local_bridge service.

Environment variables:
- SCALE_SERIAL_PORT: Serial port name for Arduino (default: COM3)
- SCALE_BAUD_RATE: Baud rate for serial communication (default: 9600)
- SCALE_SERIAL_TIMEOUT: Serial read timeout in seconds (default: 1.0)
- MODEL_CHECKPOINT_PATH: Path to the PyTorch model checkpoint (.pth)
- CAMERA_INDEX: OpenCV video capture index (default: 0)
- CAMERA_TIMEOUT: Max seconds to wait for camera frame capture (default: 3.0)
- INFERENCE_TIMEOUT: Max seconds to wait for model prediction (default: 5.0)
- LOCAL_BRIDGE_HOST: API bind address (default: 127.0.0.1)
- LOCAL_BRIDGE_PORT: API bind port (default: 8000)
"""
import os
from pathlib import Path

# Serial Scale Configuration
DEFAULT_SERIAL_PORT: str = os.getenv("SCALE_SERIAL_PORT", "AUTO")
DEFAULT_BAUD_RATE: int = int(os.getenv("SCALE_BAUD_RATE", "9600"))
SERIAL_TIMEOUT_SECONDS: float = float(os.getenv("SCALE_SERIAL_TIMEOUT", "1.0"))
SERIAL_RETRY_INTERVAL_SECONDS: float = float(os.getenv("SCALE_RETRY_INTERVAL", "2.0"))

# Vision & Model Configuration
MODELS_DIR: Path = Path(__file__).resolve().parent / "models"

# Model v1 (baseline)
_DEFAULT_V1_APP = MODELS_DIR / "convnext_tiny_3class_v1.pth"
_DEFAULT_V1_SRC = Path(r"D:\smart-retailmodeltraining\checkpoints_new\convnext_tiny_3class_v1.pth")
MODEL_V1_PATH: Path = Path(os.getenv("MODEL_V1_PATH", str(_DEFAULT_V1_APP if _DEFAULT_V1_APP.exists() else _DEFAULT_V1_SRC)))

# Model v2 (fine-tuned - default inference candidate)
# Prefer v3 domain-balanced webcam checkpoint when present, preserving original v2 on disk
_DEFAULT_V3_APP = MODELS_DIR / "convnext_tiny_3class_v3_webcam.pth"
_DEFAULT_V3_SRC = Path(r"D:\smart-retailmodeltraining\checkpoints_new\convnext_tiny_3class_v3_webcam.pth")
_DEFAULT_V2_APP = MODELS_DIR / "convnext_tiny_3class_v2_rice_finetune.pth"
_DEFAULT_V2_SRC = Path(r"D:\smart-retailmodeltraining\checkpoints_new\convnext_tiny_3class_v2_rice_finetune.pth")


def _resolve_finetuned_checkpoint() -> Path:
    for candidate in (_DEFAULT_V3_APP, _DEFAULT_V3_SRC, _DEFAULT_V2_APP, _DEFAULT_V2_SRC):
        if candidate.exists():
            return candidate
    return _DEFAULT_V2_APP


MODEL_V2_PATH: Path = Path(os.getenv("MODEL_V2_PATH", str(_resolve_finetuned_checkpoint())))

# Active model selection (v2 by default, switchable to v1)
DEFAULT_MODEL_VERSION: str = os.getenv("ACTIVE_MODEL_VERSION", "v2").lower()

# Legacy alias pointing to active candidate (v2 default)
DEFAULT_CHECKPOINT_PATH: Path = MODEL_V2_PATH if DEFAULT_MODEL_VERSION == "v2" else MODEL_V1_PATH

# Calibrated confidence threshold (0.75 default from validation results)
CONFIDENCE_THRESHOLD: float = float(os.getenv("CONFIDENCE_THRESHOLD", "0.75"))

DEFAULT_CAMERA_INDEX: int = int(os.getenv("CAMERA_INDEX", "0"))
CAMERA_CAPTURE_TIMEOUT_SECONDS: float = float(os.getenv("CAMERA_TIMEOUT", "3.0"))
INFERENCE_TIMEOUT_SECONDS: float = float(os.getenv("INFERENCE_TIMEOUT", "5.0"))

# Region of Interest (ROI) Cropping Configuration
# Default crop for 640x480 frame: centered lower crop x=140..500, y=200..480
ROI_ENABLED: bool = os.getenv("ROI_ENABLED", "true").lower() in ("true", "1", "yes")
DEFAULT_ROI_X_MIN: int = int(os.getenv("ROI_CROP_X_MIN", "140"))
DEFAULT_ROI_Y_MIN: int = int(os.getenv("ROI_CROP_Y_MIN", "200"))
DEFAULT_ROI_X_MAX: int = int(os.getenv("ROI_CROP_X_MAX", "500"))
DEFAULT_ROI_Y_MAX: int = int(os.getenv("ROI_CROP_Y_MAX", "480"))

# API Server Configuration
HOST: str = os.getenv("LOCAL_BRIDGE_HOST", "127.0.0.1")
PORT: int = int(os.getenv("LOCAL_BRIDGE_PORT", "8000"))
