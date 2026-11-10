"""Arduino Uno + HX711 Load Cell serial reader.

Parses lines matching the exact hardware firmware format:
    Weight: <float> g
Examples:
    Weight: 0.00 g
    Weight: 125.40 g
    Weight: -0.15 g

Runs in a dedicated background worker thread to prevent blocking
the FastAPI async event loop.
"""
from datetime import datetime, timezone
import logging
import re
import threading
import time
from typing import Optional

try:
    import serial
    from serial import SerialException
except ImportError:
    serial = None  # Handled gracefully if pyserial is missing in test mocks
    SerialException = Exception

from local_bridge.schemas import ScaleResponse

logger = logging.getLogger("local_bridge.scale")

WEIGHT_PATTERN = re.compile(
    r"^Weight:\s*([+-]?\d+(?:\.\d+)?)\s*g\b",
    re.IGNORECASE
)

ERROR_PATTERN = re.compile(
    r"^(?:ERROR:?\s*|)(?:HX711\s+not\s+ready|Load\s+cell\s+error)",
    re.IGNORECASE
)


def parse_scale_line(line: str) -> Optional[float]:
    """Parse raw line from Arduino HX711 serial output.

    Args:
        line: Raw string line from serial port (e.g. 'Weight: 142.50 g')

    Returns:
        Weight in grams as a float rounded to 3 decimals, or None if
        the line does not match the expected Arduino format.
    """
    if not line:
        return None
    clean = line.strip()
    match = WEIGHT_PATTERN.search(clean)
    if not match:
        return None
    try:
        val = float(match.group(1))
        return round(val, 3)
    except (ValueError, TypeError):
        return None


class ScaleReader:
    """Manages the serial connection and background polling for the load cell."""

    def __init__(
        self,
        port: str = "AUTO",
        baudrate: int = 9600,
        timeout: float = 1.0,
        retry_interval: float = 2.0,
    ) -> None:
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.retry_interval = retry_interval

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Verified connection and measurement state
        self._connected: bool = False
        self._last_weight: Optional[float] = None
        self._last_timestamp: Optional[datetime] = None
        self._last_raw_line: Optional[str] = None
        self._error_detail: Optional[str] = None
        self._sensor_error: Optional[str] = None

        self._serial_handle = None

    def start(self) -> None:
        """Start the background serial reader thread."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="ScaleReaderWorker",
            daemon=True,
        )
        self._thread.start()
        logger.info("ScaleReader thread started on port %s @ %d baud", self.port, self.baudrate)

    def stop(self) -> None:
        """Signal the worker thread to stop and close the serial port."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        self._close_serial()
        with self._lock:
            self._connected = False
        logger.info("ScaleReader stopped.")

    def _close_serial(self) -> None:
        """Safely close active serial handle."""
        if self._serial_handle is not None:
            try:
                self._serial_handle.close()
            except Exception as exc:
                logger.debug("Error closing serial handle: %s", exc)
            finally:
                self._serial_handle = None

    def _find_candidate_ports(self) -> list[str]:
        """Discover available serial ports, prioritizing known Arduino / CH340 / USB-Serial devices."""
        if serial is None:
            return [self.port] if self.port != "AUTO" else []

        try:
            from serial.tools import list_ports
            detected = list(list_ports.comports())
        except Exception as exc:
            logger.debug("Failed to list serial ports: %s", exc)
            return [self.port] if self.port != "AUTO" else []

        if not detected:
            return [self.port] if self.port != "AUTO" else []

        high_priority: list[str] = []
        low_priority: list[str] = []
        for p in detected:
            desc = (p.description or "").lower()
            mfg = (p.manufacturer or "").lower()
            hwid = (p.hwid or "").lower()
            if any(k in desc or k in mfg or k in hwid for k in ["ch340", "arduino", "usb serial", "usb-serial", "wch", "ftdi", "cp210"]):
                high_priority.append(p.device)
            else:
                low_priority.append(p.device)

        configured = [self.port] if (self.port and self.port != "AUTO") else []
        ordered = high_priority + [p for p in configured if p not in high_priority and p in [d.device for d in detected]] + low_priority
        seen = set()
        unique: list[str] = []
        for c in ordered:
            if c not in seen:
                seen.add(c)
                unique.append(c)
        return unique or ([self.port] if self.port != "AUTO" else [])

    def _run_loop(self) -> None:
        """Main loop executed by worker thread."""
        while not self._stop_event.is_set():
            if serial is None:
                with self._lock:
                    self._connected = False
                    self._error_detail = "pyserial package not installed"
                time.sleep(self.retry_interval)
                continue

            # Attempt auto-detection and connection if not already open
            if self._serial_handle is None:
                candidate_ports = self._find_candidate_ports()
                if candidate_ports:
                    self.port = candidate_ports[0]

                opened_ser = None
                conn_error = None

                for target_port in candidate_ports:
                    try:
                        logger.debug("Attempting to connect to serial port %s...", target_port)
                        ser = serial.Serial(
                            port=target_port,
                            baudrate=self.baudrate,
                            timeout=self.timeout,
                        )
                        # Flush any stale garbage in buffer
                        ser.reset_input_buffer()
                        opened_ser = ser
                        self.port = target_port
                        logger.info("Serial port %s opened successfully.", target_port)
                        break
                    except (SerialException, PermissionError, FileNotFoundError, OSError) as exc:
                        msg = str(exc)
                        if isinstance(exc, PermissionError) or "access is denied" in msg.lower():
                            conn_error = (
                                f"Port {target_port} is busy or locked by another application (e.g. Arduino IDE Serial Monitor). "
                                "Please close the Serial Monitor in Arduino IDE."
                            )
                        else:
                            conn_error = f"Cannot open {target_port}: {exc}"
                        logger.debug("Serial connection attempt failed on %s: %s", target_port, exc)

                if opened_ser is not None:
                    self._serial_handle = opened_ser
                    with self._lock:
                        self._error_detail = None
                else:
                    with self._lock:
                        self._connected = False
                        self._error_detail = conn_error or "Scanning USB ports for Arduino HX711 scale..."
                    # Sleep before retrying to prevent tight CPU spin
                    self._stop_event.wait(self.retry_interval)
                    continue

            # Read from open serial port
            try:
                raw_bytes = self._serial_handle.readline()
                if not raw_bytes:
                    # Readline timed out with no data received
                    continue

                line_str = raw_bytes.decode("utf-8", errors="replace").strip()
                if not line_str:
                    continue

                weight = parse_scale_line(line_str)
                is_error = bool(ERROR_PATTERN.search(line_str))

                with self._lock:
                    self._last_raw_line = line_str
                    if is_error:
                        logger.warning("Hardware scale error reported: %s", line_str)
                        self._sensor_error = line_str
                        self._last_weight = None  # Do not serve stale/zero weight during sensor error
                        self._connected = True
                    elif weight is not None:
                        self._last_weight = weight
                        self._last_timestamp = datetime.now(timezone.utc)
                        self._connected = True
                        self._error_detail = None
                        self._sensor_error = None
                    else:
                        # Informational line (e.g. startup banner, tare confirmation)
                        self._connected = True

            except (SerialException, OSError, StopIteration) as exc:
                if isinstance(exc, StopIteration):
                    logger.debug("Serial stream EOF or mock iteration ended.")
                    break
                logger.warning("Serial connection dropped on %s: %s", self.port, exc)
                self._close_serial()
                with self._lock:
                    self._connected = False
                    self._error_detail = f"Serial read error: {exc}"
                    self._sensor_error = None
                self._stop_event.wait(self.retry_interval)

    def is_connected(self) -> bool:
        """Return True only if serial port is open and verified communicating."""
        with self._lock:
            return self._connected

    def get_reading(self) -> ScaleResponse:
        """Get latest real weight reading and connection status."""
        with self._lock:
            if not self._connected:
                return ScaleResponse(
                    connected=False,
                    weight_grams=None,
                    unit="g",
                    timestamp=self._last_timestamp,
                    status="disconnected",
                    port=self.port,
                    detail=self._error_detail or f"Serial port {self.port} not connected",
                )

            if self._sensor_error is not None:
                return ScaleResponse(
                    connected=True,
                    weight_grams=None,
                    unit="g",
                    timestamp=self._last_timestamp,
                    status="sensor_error",
                    port=self.port,
                    detail=f"Load cell hardware reported: {self._sensor_error}",
                )

            if self._last_weight is None:
                return ScaleResponse(
                    connected=True,
                    weight_grams=None,
                    unit="g",
                    timestamp=self._last_timestamp,
                    status="awaiting_data",
                    port=self.port,
                    detail="Serial port open, awaiting initial 'Weight: <val> g' frame",
                )

            return ScaleResponse(
                connected=True,
                weight_grams=self._last_weight,
                unit="g",
                timestamp=self._last_timestamp,
                status="connected",
                port=self.port,
                detail=None,
            )
