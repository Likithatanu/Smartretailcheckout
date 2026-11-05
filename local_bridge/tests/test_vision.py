"""Tests for webcam capture error handling and vision model inference."""
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
import numpy as np
import pytest

from local_bridge.camera_manager import CameraUnavailableError
from local_bridge.main import app, classifier
from local_bridge.model_loader import (
    InvalidRoiError,
    ModelLoadError,
    VisionClassifier,
    crop_roi,
)


@pytest.fixture(scope="module")
def client():
    """Test client with loaded model."""
    if not classifier.is_loaded:
        classifier.load()
    with TestClient(app) as test_client:
        yield test_client


def test_vision_missing_camera_returns_503(client):
    """Verify that camera failure returns an explicit 503 error and NO fake prediction."""
    with patch(
        "local_bridge.main.camera_manager.capture_frame",
        side_effect=CameraUnavailableError("Camera 0 busy or disconnected"),
    ):
        response = client.get("/vision/predict")

    assert response.status_code == 503
    data = response.json()
    assert "detail" in data
    assert "Camera unavailable" in data["detail"] or "busy" in data["detail"]


def test_vision_mocked_camera_inference(client):
    """Verify end-to-end vision classification with a mock camera frame."""
    # Synthetic 640x480 RGB image frame
    synthetic_frame = np.full((480, 640, 3), 128, dtype=np.uint8)

    with patch(
        "local_bridge.main.camera_manager.capture_frame",
        return_value=synthetic_frame,
    ):
        response = client.get("/vision/predict")

    assert response.status_code == 200
    data = response.json()

    assert data["predicted_class"] in {"chana_dal", "masur_dal", "rice"}
    assert 0.0 <= data["confidence"] <= 1.0

    probs = data["probabilities"]
    assert set(probs.keys()) == {"chana_dal", "masur_dal", "rice"}
    assert pytest.approx(sum(probs.values()), rel=1e-2) == 1.0

    assert data["image_size"] == 224
    assert "timestamp" in data
    # Diagnostic ROI field present and accurate
    assert "roi" in data
    assert data["roi"] is not None
    assert data["roi"]["enabled"] is True
    assert data["roi"]["original_width"] == 640
    assert data["roi"]["original_height"] == 480
    assert data["roi"]["cropped_width"] == 360
    assert data["roi"]["cropped_height"] == 280
    assert data["roi"]["x_min"] == 140
    assert data["roi"]["x_max"] == 500
    assert data["roi"]["y_min"] == 200
    assert data["roi"]["y_max"] == 480


def test_crop_roi_valid_coordinates():
    """Verify crop_roi extracts the exact rectangular region and metadata."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cropped, roi_info = crop_roi(frame, x_min=140, y_min=200, x_max=500, y_max=480)

    assert cropped.shape == (280, 360, 3)
    assert roi_info.enabled is True
    assert roi_info.x_min == 140
    assert roi_info.y_min == 200
    assert roi_info.x_max == 500
    assert roi_info.y_max == 480
    assert roi_info.original_width == 640
    assert roi_info.original_height == 480
    assert roi_info.cropped_width == 360
    assert roi_info.cropped_height == 280


def test_crop_roi_invalid_bounds():
    """Verify crop_roi throws InvalidRoiError on out-of-bound or inverted coordinates."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    # 1. x_max exceeds width
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=140, y_min=200, x_max=641, y_max=480)
    assert "exceeds frame width" in str(exc.value)

    # 2. y_max exceeds height
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=140, y_min=200, x_max=500, y_max=481)
    assert "exceeds frame height" in str(exc.value)

    # 3. Negative coordinates
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=-5, y_min=200, x_max=500, y_max=480)
    assert "non-negative" in str(exc.value)

    # 4. Inverted x bounds (x_min >= x_max)
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=500, y_min=200, x_max=140, y_max=480)
    assert "strictly less than" in str(exc.value)

    # 5. Inverted y bounds (y_min >= y_max)
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=140, y_min=480, x_max=500, y_max=200)
    assert "strictly less than" in str(exc.value)

    # 6. Dimensions too small (< 16px)
    with pytest.raises(InvalidRoiError) as exc:
        crop_roi(frame, x_min=140, y_min=200, x_max=148, y_max=208)
    assert "too small" in str(exc.value)


def test_vision_predict_frame_too_small_returns_400(client):
    """Verify that if camera delivers a frame smaller than configured ROI, returns HTTP 400."""
    # Frame is 320x240, while default ROI expects x up to 500 and y up to 480
    small_frame = np.full((240, 320, 3), 128, dtype=np.uint8)

    with patch(
        "local_bridge.main.camera_manager.capture_frame",
        return_value=small_frame,
    ):
        response = client.get("/vision/predict")

    assert response.status_code == 400
    data = response.json()
    assert "detail" in data
    assert "ROI crop validation failed" in data["detail"]
    assert "exceeds frame" in data["detail"]


def test_vision_roi_diagnostic_endpoint(client):
    """Verify /vision/roi endpoint safely returns configured crop parameters."""
    response = client.get("/vision/roi")
    assert response.status_code == 200
    data = response.json()

    assert data["enabled"] is True
    assert data["x_min"] == 140
    assert data["y_min"] == 200
    assert data["x_max"] == 500
    assert data["y_max"] == 480
    assert "Crop box" in data["description"]
    # Ensure no filesystem path is leaked
    assert "D:\\" not in str(data) and "C:\\" not in str(data)


def test_model_loader_missing_checkpoint():
    """Verify ModelLoadError is raised when checkpoint path does not exist."""
    bad_classifier = VisionClassifier(Path("D:/non_existent_checkpoint.pth"))
    with pytest.raises(ModelLoadError) as exc_info:
        bad_classifier.load()
    assert "Model checkpoint file not found" in str(exc_info.value)


def test_vision_model_status_and_switch(client):
    """Verify /vision/model returns active version and supports switching between v1 and v2."""
    # 1. Query model status (default v2)
    res = client.get("/vision/model")
    assert res.status_code == 200
    data = res.json()
    assert data["active_version"] in ("v1", "v2")
    assert set(data["available_versions"]) == {"v1", "v2"}
    assert data["confidence_threshold"] == 0.75

    # 2. Switch to v1 (baseline)
    res_v1 = client.post("/vision/model", json={"version": "v1"})
    assert res_v1.status_code == 200
    assert res_v1.json()["active_version"] == "v1"

    # 3. Switch back to v2 (fine-tuned default)
    res_v2 = client.post("/vision/model", json={"version": "v2"})
    assert res_v2.status_code == 200
    assert res_v2.json()["active_version"] == "v2"

    # 4. Attempt invalid version switch
    res_bad = client.post("/vision/model", json={"version": "v99"})
    assert res_bad.status_code == 400


def test_vision_prediction_metadata_and_version_override(client):
    """Verify /vision/predict returns model_version, confidence_threshold, and is_confident."""
    synthetic_frame = np.full((480, 640, 3), 128, dtype=np.uint8)

    with patch(
        "local_bridge.main.camera_manager.capture_frame",
        return_value=synthetic_frame,
    ):
        # Default prediction (v2)
        res_v2 = client.get("/vision/predict")
        assert res_v2.status_code == 200
        data_v2 = res_v2.json()
        assert data_v2["model_version"] == "v2"
        assert isinstance(data_v2["is_confident"], bool)
        assert data_v2["confidence_threshold"] == 0.75

        # Explicit version override to v1
        res_v1 = client.get("/vision/predict?version=v1")
        assert res_v1.status_code == 200
        data_v1 = res_v1.json()
        assert data_v1["model_version"] == "v1"

