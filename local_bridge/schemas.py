"""Pydantic schemas for local_bridge API responses."""
from datetime import datetime
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Health status of the local hardware and AI bridge."""
    status: str = Field(..., description="Overall status: 'ok' or 'degraded'")
    api_running: bool = Field(True, description="Whether the FastAPI server is active")
    model_loaded: bool = Field(..., description="Whether the vision model checkpoint is loaded")
    model_name: Optional[str] = Field(None, description="Architecture of the vision model")
    classes: Optional[List[str]] = Field(None, description="Recognized vision class labels")
    serial_connected: bool = Field(..., description="Whether the Arduino serial device is actively communicating")
    serial_port: str = Field(..., description="Configured serial port name")
    camera_available: bool = Field(..., description="Whether the webcam device is accessible")
    active_model_version: str = Field("v2", description="Active model checkpoint version ('v1' or 'v2')")
    available_model_versions: List[str] = Field(default_factory=lambda: ["v1", "v2"], description="Available model versions")


class ScaleResponse(BaseModel):
    """Latest reading from the calibrated HX711 load cell."""
    connected: bool = Field(..., description="Connection status of the scale serial device")
    weight_grams: Optional[float] = Field(None, description="Weight measurement in grams, or null if disconnected")
    unit: str = Field("g", description="Unit of measurement")
    timestamp: Optional[datetime] = Field(None, description="ISO-8601 timestamp of the measurement")
    status: str = Field(..., description="Status string: 'connected', 'disconnected', or 'awaiting_data'")
    port: str = Field(..., description="Configured serial port name")
    detail: Optional[str] = Field(None, description="Diagnostic error or informational message")


class RoiCropInfo(BaseModel):
    """Region of Interest (ROI) crop geometry and dimensions."""
    enabled: bool = Field(..., description="Whether ROI cropping was applied")
    x_min: int = Field(..., description="Left coordinate of crop bounding box")
    y_min: int = Field(..., description="Top coordinate of crop bounding box")
    x_max: int = Field(..., description="Right coordinate of crop bounding box")
    y_max: int = Field(..., description="Bottom coordinate of crop bounding box")
    original_width: int = Field(..., description="Original frame width before cropping")
    original_height: int = Field(..., description="Original frame height before cropping")
    cropped_width: int = Field(..., description="Resulting width after cropping")
    cropped_height: int = Field(..., description="Resulting height after cropping")


class RoiConfigResponse(BaseModel):
    """Current ROI configuration parameters."""
    enabled: bool = Field(..., description="Whether ROI cropping is currently active")
    x_min: int = Field(..., description="Configured minimum X coordinate")
    y_min: int = Field(..., description="Configured minimum Y coordinate")
    x_max: int = Field(..., description="Configured maximum X coordinate")
    y_max: int = Field(..., description="Configured maximum Y coordinate")
    description: str = Field(..., description="Human-readable description of current ROI configuration")


class VisionPredictionResponse(BaseModel):
    """Vision prediction result from the ConvNeXt-Tiny classifier."""
    predicted_class: str = Field(..., description="Class name with highest prediction probability")
    confidence: float = Field(..., description="Prediction confidence score between 0.0 and 1.0")
    probabilities: Dict[str, float] = Field(..., description="Probability breakdown across all 3 classes")
    image_size: int = Field(224, description="Model input image dimension (square)")
    timestamp: datetime = Field(..., description="ISO-8601 timestamp when the prediction was generated")
    roi: Optional[RoiCropInfo] = Field(None, description="Diagnostic crop metadata and dimensions if ROI applied")
    model_version: str = Field("v2", description="Model checkpoint version ('v1' or 'v2')")
    is_confident: bool = Field(True, description="Whether prediction meets or exceeds confidence threshold")
    confidence_threshold: float = Field(0.75, description="Calibrated confidence threshold applied")


class VisionPredictRequest(BaseModel):
    """Payload to classify grain product from a base64-encoded webcam frame."""
    image_base64: Optional[str] = Field(None, description="Base64 encoded JPEG or PNG image frame data")
    version: Optional[str] = Field(None, description="Optional model version override ('v1' or 'v2')")


class ModelSwitchRequest(BaseModel):
    """Request payload to switch the active model checkpoint."""
    version: str = Field(..., description="Target model version: 'v1' or 'v2'")


class ModelStatusResponse(BaseModel):
    """Status information about active and available vision model checkpoints."""
    active_version: str = Field(..., description="Currently active model version ('v1' or 'v2')")
    available_versions: List[str] = Field(default_factory=lambda: ["v1", "v2"], description="List of supported model versions")
    v1_loaded: bool = Field(..., description="Whether v1 baseline model is loaded in memory")
    v2_loaded: bool = Field(..., description="Whether v2 fine-tuned model is loaded in memory")
    v1_path: str = Field(..., description="File path for v1 baseline checkpoint")
    v2_path: str = Field(..., description="File path for v2 fine-tuned checkpoint")
    confidence_threshold: float = Field(..., description="Configured confidence threshold")


class ErrorResponse(BaseModel):
    """Standardized error response."""
    error: str = Field(..., description="Error identifier")
    detail: str = Field(..., description="Detailed explanation of the error")
