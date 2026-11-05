"""Tests for scale parsing and scale reader service."""
from unittest.mock import MagicMock, patch
import pytest

from local_bridge.scale_reader import ScaleReader, parse_scale_line
from local_bridge.schemas import ScaleResponse


def test_parse_scale_line_valid_readings():
    """Verify correct extraction of weight values across formatting variants."""
    assert parse_scale_line("Weight: 0.00 g") == 0.0
    assert parse_scale_line("Weight: 142.50 g") == 142.50
    assert parse_scale_line("Weight: 5.234 g") == 5.234
    assert parse_scale_line("Weight: 1200.00 g\r\n") == 1200.0
    assert parse_scale_line("Weight: -0.15 g") == -0.15
    assert parse_scale_line("Weight:   45.8   g  ") == 45.8
    assert parse_scale_line("weight: 10.5 g") == 10.5


def test_parse_scale_line_invalid_readings():
    """Verify that malformed or non-weight lines return None without crashing."""
    assert parse_scale_line("") is None
    assert parse_scale_line("HX711 Calibrated and Ready") is None
    assert parse_scale_line("Weight: g") is None
    assert parse_scale_line("Weight: abc g") is None
    assert parse_scale_line("142.50 g") is None
    assert parse_scale_line("Weight: 50.0 kg") is None
    assert parse_scale_line("Reading error: timeout") is None


def test_scale_reader_disconnected_state():
    """Verify that an uninitialized/unconnected scale reader reports disconnected status."""
    reader = ScaleReader(port="COM999", retry_interval=10.0)
    # Without starting worker or with port failing to open:
    reading = reader.get_reading()

    assert isinstance(reading, ScaleResponse)
    assert reading.connected is False
    assert reading.weight_grams is None
    assert reading.status == "disconnected"
    assert reading.port == "COM999"
    assert reading.unit == "g"


def test_scale_reader_mocked_serial_stream():
    """Verify ScaleReader worker thread with simulated serial communication."""
    mock_serial = MagicMock()
    # Simulate an initialization line, then a valid weight line, then empty timeout
    mock_serial.readline.side_effect = [
        b"HX711 Initialized\r\n",
        b"Weight: 245.50 g\r\n",
        b"",
        b"",
    ]
    mock_serial.is_open = True

    with patch("serial.Serial", return_value=mock_serial):
        reader = ScaleReader(port="COM3", retry_interval=0.1)
        reader.start()

        # Allow worker thread a brief slice to process mock stream
        import time
        time.sleep(0.3)

        reading = reader.get_reading()
        reader.stop()

    assert reading.connected is True
    assert reading.weight_grams == 245.50
    assert reading.status == "connected"
    assert reading.timestamp is not None
