"""Webcam lifecycle manager using OpenCV.

Ensures:
- Safe single-handle access (avoids competing connections to the same camera device).
- Thread-safe frame capture with a mutex lock.
- Clean release on service shutdown.
- Clear error reporting if camera cannot be accessed or is in use.
"""
import logging
import sys
import threading
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger("local_bridge.camera")


class CameraUnavailableError(Exception):
    """Raised when the camera device cannot be opened."""
    pass


class CameraCaptureError(Exception):
    """Raised when a video frame could not be read from an opened camera."""
    pass


class CameraManager:
    """Thread-safe webcam manager."""

    def __init__(self, camera_index: int = 0) -> None:
        self.camera_index = camera_index
        self._lock = threading.Lock()
        self._cap: Optional[cv2.VideoCapture] = None
        self._cached_available: Optional[bool] = None

    def _open_capture(self) -> cv2.VideoCapture:
        """Attempt to open webcam using DirectShow first, then default backend."""
        logger.debug("Attempting to open camera index %d with cv2.CAP_DSHOW...", self.camera_index)
        cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            logger.debug("DirectShow failed. Falling back to default backend for camera index %d...", self.camera_index)
            cap.release()
            cap = cv2.VideoCapture(self.camera_index)

        if not cap.isOpened():
            cap.release()
            raise CameraUnavailableError(
                f"Could not open webcam at index {self.camera_index}. "
                "Ensure the camera is plugged in, privacy settings permit access, "
                "and no other application is using it."
            )

        # Set standard 640x480 resolution for low latency
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        return cap

    def capture_frame(self) -> np.ndarray:
        """Capture a single frame from the webcam in RGB format.

        Opens camera on-demand and promptly releases device handle so other
        processes (e.g. browser WebRTC / HTML5 webcam) are not locked out.

        Returns:
            np.ndarray: RGB image array of shape (H, W, 3)

        Raises:
            CameraUnavailableError: If camera device cannot be opened.
            CameraCaptureError: If reading a frame fails.
        """
        with self._lock:
            cap: Optional[cv2.VideoCapture] = None
            try:
                cap = self._open_capture()
                # Discard any stale buffer frame and read latest
                ret, frame = cap.read()
                if not ret or frame is None:
                    # Attempt one retry in case buffer glitched
                    logger.warning("Failed to read frame on first attempt. Retrying...")
                    ret, frame = cap.read()
                    if not ret or frame is None:
                        raise CameraCaptureError(
                            f"Camera index {self.camera_index} is opened but failed to deliver a valid video frame."
                        )
                # OpenCV captures BGR by default; convert to RGB for PIL / PyTorch
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                return rgb_frame
            finally:
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                self._release_internal()

    def check_availability(self) -> bool:
        """Zero-lock check if a camera device is registered on the system.

        Critically avoids calling cv2.VideoCapture() on every /health poll,
        because opening DirectShow / MediaFoundation on Windows grabs an
        exclusive hardware lock that causes browser getUserMedia() to fail
        with NotReadableError ('Camera is in use by another application').
        """
        if sys.platform == "win32":
            try:
                import winreg
                cam_guid = r"SYSTEM\CurrentControlSet\Control\DeviceClasses\{e5323777-f976-4f5b-9b55-b94699c46e44}"
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, cam_guid) as k:
                    i = 0
                    while True:
                        try:
                            sub = winreg.EnumKey(k, i)
                            if sub and sub.lower() != "properties":
                                return True
                        except OSError:
                            break
                        i += 1
            except Exception as exc:
                logger.debug("Registry camera probe fallback: %s", exc)

        with self._lock:
            if self._cap is not None and self._cap.isOpened():
                return True
            if self._cached_available is not None:
                return self._cached_available
            try:
                cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
                if not cap.isOpened():
                    cap.release()
                    cap = cv2.VideoCapture(self.camera_index)
                is_open = cap.isOpened()
                cap.release()
                self._cached_available = is_open
                return is_open
            except Exception:
                return False

    def release(self) -> None:
        """Safely release the camera device on application shutdown."""
        with self._lock:
            self._release_internal()

    def _release_internal(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception as exc:
                logger.debug("Error releasing camera: %s", exc)
            finally:
                self._cap = None
        logger.info("Camera device released.")
