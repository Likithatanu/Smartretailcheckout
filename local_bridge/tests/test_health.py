"""Tests for health and status diagnostics."""
from fastapi.testclient import TestClient
import pytest

from local_bridge.main import app, classifier, scale_reader


@pytest.fixture(scope="module")
def client():
    """Test client fixture."""
    if not classifier.is_loaded:
        classifier.load()
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint_structure(client):
    """Verify /health reports API status, model loading, and verified serial status."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()

    assert data["api_running"] is True
    assert data["model_loaded"] is True
    assert data["model_name"] == "convnext_tiny"
    assert set(data["classes"]) == {"chana_dal", "masur_dal", "rice"}
    assert isinstance(data["serial_connected"], bool)
    assert data["serial_port"] == "COM3"
    assert isinstance(data["camera_available"], bool)
    assert data["status"] in {"ok", "degraded"}


def test_scale_endpoint_structure(client):
    """Verify /scale returns structured payload without fabricated weights."""
    response = client.get("/scale")
    assert response.status_code == 200
    data = response.json()

    assert "connected" in data
    assert "unit" in data
    assert data["unit"] == "g"
    assert "status" in data

    if not data["connected"]:
        assert data["weight_grams"] is None
        assert data["status"] in {"disconnected", "awaiting_data"}
    else:
        assert isinstance(data["weight_grams"], float)
        assert data["status"] == "connected"
