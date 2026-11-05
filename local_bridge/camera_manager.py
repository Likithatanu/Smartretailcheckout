"""Webcam lifecycle manager using OpenCV.

Ensures:
- Safe single-handle access (avoids competing connections to the same camera device).
- Thread-safe frame capture with a mutex lock.
- Clean release on service shutdown.
- Clear error reporting if camera cannot be accessed or is in use.
"""
import logging
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

        Returns:
            np.ndarray: RGB image array of shape (H, W, 3)

        Raises:
            CameraUnavailableError: If camera device cannot be opened.
            CameraCaptureError: If reading a frame fails.
        """
        with self._lock:
            if self._cap is None or not self._cap.isOpened():
                self._cap = self._open_capture()

            # Discard any stale buffer frame and read latest
            ret, frame = self._cap.read()
            if not ret or frame is None:
                # Attempt one reset in case buffer glitched
                logger.warning("Failed to read frame. Re-initializing camera capture...")
                self._release_internal()
                self._cap = self._open_capture()
                ret, frame = self._cap.read()
                if not ret or frame is None:
                    self._release_internal()
                    raise CameraCaptureError(
                        f"Camera index {self.camera_index} is opened but failed to deliver a valid video frame."
                    )
            # OpenCV captures BGR by default; convert to RGB for PIL / PyTorch
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            return rgb_frame

    def check_availability(self) -> bool:
        """Non-destructive check if camera is available."""
        with self._lock:
            if self._cap is not None and self._cap.isOpened():
                return True
            try:
                cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
                if not cap.isOpened():
                    cap.release()
                    cap = cv2.VideoCapture(self.camera_index)
                is_open = cap.isOpened()
                cap.release()
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
