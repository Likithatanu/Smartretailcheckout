"""Vision model loader and inference engine for grain classification.

Loads and manages trained ConvNeXt-Tiny PyTorch checkpoints:
- v1 (baseline): convnext_tiny_3class_v1.pth
- v2 (fine-tuned): convnext_tiny_3class_v2_rice_finetune.pth (default)
- Architecture: timm convnext_tiny
- Classes: chana_dal (0), masur_dal (1), rice (2)
- Input: RGB 224x224
- Mean: [0.485, 0.456, 0.406], Std: [0.229, 0.224, 0.225]
"""
from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
import timm
import torch
from torchvision import transforms

from local_bridge import config
from local_bridge.schemas import RoiCropInfo, VisionPredictionResponse

logger = logging.getLogger("local_bridge.model")


class ModelLoadError(Exception):
    """Raised when the model checkpoint cannot be loaded or initialized."""
    pass


class ModelInferenceError(Exception):
    """Raised when an inference forward pass fails."""
    pass


class InvalidRoiError(Exception):
    """Raised when ROI crop coordinates are out of bounds or mathematically invalid."""
    pass


def crop_roi(
    image_rgb: np.ndarray,
    x_min: int,
    y_min: int,
    x_max: int,
    y_max: int,
) -> Tuple[np.ndarray, RoiCropInfo]:
    """Crop Region of Interest from an RGB image frame.

    Args:
        image_rgb: Numpy array of shape (H, W, 3).
        x_min: Left coordinate.
        y_min: Top coordinate.
        x_max: Right coordinate.
        y_max: Bottom coordinate.

    Returns:
        Tuple of (cropped_image_array, RoiCropInfo).

    Raises:
        InvalidRoiError: If bounds exceed frame dimensions or are invalid.
    """
    if not isinstance(image_rgb, np.ndarray) or image_rgb.ndim < 2:
        raise InvalidRoiError("Input image must be a valid numpy array with at least 2 dimensions.")

    h, w = image_rgb.shape[:2]

    if x_min < 0 or y_min < 0:
        raise InvalidRoiError(
            f"ROI coordinates must be non-negative: x_min={x_min}, y_min={y_min}."
        )
    if x_max > w:
        raise InvalidRoiError(
            f"ROI x_max ({x_max}) exceeds frame width ({w})."
        )
    if y_max > h:
        raise InvalidRoiError(
            f"ROI y_max ({y_max}) exceeds frame height ({h})."
        )
    if x_min >= x_max:
        raise InvalidRoiError(
            f"ROI x_min ({x_min}) must be strictly less than x_max ({x_max})."
        )
    if y_min >= y_max:
        raise InvalidRoiError(
            f"ROI y_min ({y_min}) must be strictly less than y_max ({y_max})."
        )

    cropped_w = x_max - x_min
    cropped_h = y_max - y_min
    if cropped_w < 16 or cropped_h < 16:
        raise InvalidRoiError(
            f"Cropped dimensions ({cropped_w}x{cropped_h}) are too small for model input (minimum 16x16 required)."
        )

    cropped_image = image_rgb[y_min:y_max, x_min:x_max]
    roi_info = RoiCropInfo(
        enabled=True,
        x_min=x_min,
        y_min=y_min,
        x_max=x_max,
        y_max=y_max,
        original_width=w,
        original_height=h,
        cropped_width=cropped_w,
        cropped_height=cropped_h,
    )
    return cropped_image, roi_info


class VisionClassifier:
    """Manages the ConvNeXt-Tiny PyTorch models (v1 and v2) and executes inference."""

    def __init__(
        self,
        checkpoint_path: Optional[Path] = None,
        device_name: str = "cpu",
        v1_path: Optional[Path] = None,
        v2_path: Optional[Path] = None,
        active_version: Optional[str] = None,
        confidence_threshold: Optional[float] = None,
    ) -> None:
        self.device = torch.device(device_name)
        self.v1_path = Path(v1_path or config.MODEL_V1_PATH)
        self.v2_path = Path(v2_path or config.MODEL_V2_PATH)
        self.active_version = (active_version or config.DEFAULT_MODEL_VERSION).lower()
        self.confidence_threshold = (
            confidence_threshold if confidence_threshold is not None else config.CONFIDENCE_THRESHOLD
        )

        # Legacy checkpoint path support
        self.checkpoint_path = Path(checkpoint_path) if checkpoint_path else (
            self.v2_path if self.active_version == "v2" else self.v1_path
        )
        self._legacy_mode = checkpoint_path is not None

        self._models: Dict[str, torch.nn.Module] = {}
        self.class_to_idx: Dict[str, int] = {}
        self.idx_to_class: Dict[int, str] = {}
        self.model_name: str = "convnext_tiny"
        self.image_size: int = 224

        self.preprocess = transforms.Compose([
            transforms.Resize((self.image_size, self.image_size)),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ])

    @property
    def model(self) -> Optional[torch.nn.Module]:
        """Return the active PyTorch model instance for backward compatibility."""
        return self._models.get(self.active_version)

    @property
    def is_loaded(self) -> bool:
        """Return True if the currently active model is loaded and ready."""
        return self.active_version in self._models

    def is_version_loaded(self, version: str) -> bool:
        """Return True if the specified model version is loaded."""
        return version.lower() in self._models

    def get_classes(self) -> List[str]:
        """Return list of supported class names."""
        if self.class_to_idx:
            return sorted(self.class_to_idx.keys(), key=lambda k: self.class_to_idx[k])
        return ["chana_dal", "masur_dal", "rice"]

    def _load_checkpoint(self, path: Path) -> Tuple[torch.nn.Module, dict]:
        """Load and instantiate a single ConvNeXt checkpoint file."""
        if not path.exists():
            raise ModelLoadError(f"Model checkpoint file not found at: {path}")

        logger.info("Loading vision checkpoint from %s...", path)
        try:
            checkpoint = torch.load(
                path,
                map_location=self.device,
                weights_only=True,
            )
        except Exception as exc:
            raise ModelLoadError(f"Failed to load checkpoint file at {path}: {exc}") from exc

        if "class_to_idx" not in checkpoint or "model_name" not in checkpoint:
            raise ModelLoadError(
                f"Checkpoint at {path} missing required metadata keys ('class_to_idx', 'model_name')."
            )

        model_name = checkpoint["model_name"]
        class_to_idx = checkpoint["class_to_idx"]

        state_dict = checkpoint.get("model_state_dict") or checkpoint.get("state_dict")
        if state_dict is None:
            raise ModelLoadError(f"Checkpoint at {path} missing state_dict.")

        try:
            model = timm.create_model(
                model_name,
                pretrained=False,
                num_classes=len(class_to_idx),
            )
            model.load_state_dict(state_dict)
            model.to(self.device)
            model.eval()
        except Exception as exc:
            raise ModelLoadError(f"Failed to instantiate timm model '{model_name}': {exc}") from exc

        return model, checkpoint

    def load(self, version: Optional[str] = None) -> None:
        """Load specified or default models into memory."""
        if self._legacy_mode and self.checkpoint_path:
            # Explicit legacy path passed in constructor
            model, ckpt = self._load_checkpoint(self.checkpoint_path)
            self.model_name = ckpt["model_name"]
            self.class_to_idx = ckpt["class_to_idx"]
            self.idx_to_class = {idx: name for name, idx in self.class_to_idx.items()}
            self.image_size = int(ckpt.get("image_size", 224))
            self._models[self.active_version] = model
            logger.info("Legacy checkpoint loaded into active slot '%s'.", self.active_version)
            return

        target_version = (version or self.active_version).lower()

        # Load target candidate
        if target_version == "v2":
            model, ckpt = self._load_checkpoint(self.v2_path)
            self._models["v2"] = model
            self.class_to_idx = ckpt["class_to_idx"]
            self.idx_to_class = {idx: name for name, idx in self.class_to_idx.items()}
            self.model_name = ckpt["model_name"]
        elif target_version == "v1":
            model, ckpt = self._load_checkpoint(self.v1_path)
            self._models["v1"] = model
            self.class_to_idx = ckpt["class_to_idx"]
            self.idx_to_class = {idx: name for name, idx in self.class_to_idx.items()}
            self.model_name = ckpt["model_name"]
        else:
            raise ModelLoadError(f"Unknown model version '{target_version}'. Must be 'v1' or 'v2'.")

        # Also pre-load the alternate model in the background if it exists on disk
        other_version = "v1" if target_version == "v2" else "v2"
        other_path = self.v1_path if target_version == "v2" else self.v2_path
        if other_version not in self._models and other_path.exists():
            try:
                other_model, _ = self._load_checkpoint(other_path)
                self._models[other_version] = other_model
                logger.info("Pre-loaded alternate model '%s' for instant fallback.", other_version)
            except Exception as exc:
                logger.warning("Could not pre-load alternate model '%s': %s", other_version, exc)

        logger.info(
            "Vision models ready. Active version: '%s'. Loaded versions: %s",
            self.active_version,
            list(self._models.keys()),
        )

    def switch_version(self, version: str) -> str:
        """Switch active model between 'v1' and 'v2'. Loads on demand if not in memory."""
        ver = version.lower()
        if ver not in ("v1", "v2"):
            raise ValueError(f"Invalid model version '{version}'. Must be 'v1' or 'v2'.")

        if ver not in self._models:
            target_path = self.v2_path if ver == "v2" else self.v1_path
            model, ckpt = self._load_checkpoint(target_path)
            self._models[ver] = model
            if not self.class_to_idx:
                self.class_to_idx = ckpt["class_to_idx"]
                self.idx_to_class = {idx: name for name, idx in self.class_to_idx.items()}

        self.active_version = ver
        logger.info("Active model switched to '%s'.", ver)
        return self.active_version

    def predict(
        self,
        image_rgb: np.ndarray,
        roi_bounds: Optional[Tuple[int, int, int, int]] = None,
        version: Optional[str] = None,
    ) -> VisionPredictionResponse:
        """Run classification on an RGB numpy image frame with optional ROI cropping.

        Args:
            image_rgb: Numpy array of shape (H, W, 3) with RGB pixel values.
            roi_bounds: Optional tuple (x_min, y_min, x_max, y_max) to crop before inference.
            version: Optional version override ('v1' or 'v2'). Defaults to active_version.

        Returns:
            VisionPredictionResponse with predicted class, confidence, probabilities, and ROI metadata.
        """
        ver = (version or self.active_version).lower()
        if ver not in self._models:
            self.switch_version(ver)

        model = self._models.get(ver)
        if model is None:
            raise ModelLoadError(f"Model version '{ver}' is not loaded. Call load() first.")

        # 1. Apply ROI crop if requested
        if roi_bounds is not None:
            x_min, y_min, x_max, y_max = roi_bounds
            cropped_rgb, roi_info = crop_roi(image_rgb, x_min, y_min, x_max, y_max)
            target_image = cropped_rgb
        else:
            target_image = image_rgb
            roi_info = None

        # 2. Preprocess cropped image and execute model forward pass
        try:
            pil_image = Image.fromarray(target_image)
            tensor = self.preprocess(pil_image).unsqueeze(0).to(self.device)

            with torch.no_grad():
                logits = model(tensor)
                probs = torch.softmax(logits, dim=1)[0]

            predicted_idx = int(torch.argmax(probs).item())
            predicted_class = self.idx_to_class.get(
                predicted_idx,
                ["chana_dal", "masur_dal", "rice"][predicted_idx]
            )
            confidence = float(probs[predicted_idx].item())
            is_confident = bool(confidence >= self.confidence_threshold)

            probabilities = {
                name: float(probs[idx].item())
                for name, idx in self.class_to_idx.items()
            }

            return VisionPredictionResponse(
                predicted_class=predicted_class,
                confidence=round(confidence, 4),
                probabilities={k: round(v, 4) for k, v in probabilities.items()},
                image_size=self.image_size,
                timestamp=datetime.now(timezone.utc),
                roi=roi_info,
                model_version=ver,
                is_confident=is_confident,
                confidence_threshold=self.confidence_threshold,
            )
        except Exception as exc:
            raise ModelInferenceError(f"Prediction failed during model forward pass: {exc}") from exc
