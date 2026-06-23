"""
GPU Monitor — Real-time NVIDIA GPU metrics via pynvml.

Falls back to mock data if no NVIDIA GPU is detected.
Provides: GPU name, VRAM total/free/used, temperature, utilization %.
"""

import logging

log = logging.getLogger("gpu_monitor")

_nvml_available = False
_handle = None

try:
    import pynvml
    pynvml.nvmlInit()
    _handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    _nvml_available = True
    log.info("NVIDIA GPU detected via pynvml")
except Exception:
    log.info("No NVIDIA GPU detected — using mock GPU data")


class GPUInfo:
    """Snapshot of GPU metrics."""

    def __init__(self, name, vram_total_mb, vram_free_mb, vram_used_mb,
                 temperature, utilization, power_draw=None):
        self.name = name
        self.vram_total_mb = vram_total_mb
        self.vram_free_mb = vram_free_mb
        self.vram_used_mb = vram_used_mb
        self.temperature = temperature
        self.utilization = utilization
        self.power_draw = power_draw

    def to_dict(self):
        return {
            "name": self.name,
            "vram_total_mb": self.vram_total_mb,
            "vram_free_mb": self.vram_free_mb,
            "vram_used_mb": self.vram_used_mb,
            "temperature": self.temperature,
            "utilization": self.utilization,
            "power_draw": self.power_draw,
        }


def get_gpu_info() -> GPUInfo:
    """Get current GPU metrics. Returns mock data if no NVIDIA GPU."""
    if _nvml_available and _handle:
        try:
            name = pynvml.nvmlDeviceGetName(_handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8")

            mem = pynvml.nvmlDeviceGetMemoryInfo(_handle)
            vram_total = mem.total // (1024 * 1024)
            vram_free = mem.free // (1024 * 1024)
            vram_used = mem.used // (1024 * 1024)

            temp = pynvml.nvmlDeviceGetTemperature(
                _handle, pynvml.NVML_TEMPERATURE_GPU
            )

            util = pynvml.nvmlDeviceGetUtilizationRates(_handle)
            gpu_util = util.gpu

            try:
                power = pynvml.nvmlDeviceGetPowerUsage(_handle) / 1000.0  # mW → W
            except Exception:
                power = None

            return GPUInfo(
                name=name,
                vram_total_mb=vram_total,
                vram_free_mb=vram_free,
                vram_used_mb=vram_used,
                temperature=temp,
                utilization=gpu_util,
                power_draw=power,
            )
        except Exception as e:
            log.warning(f"GPU read error: {e}")

    # Mock data
    return GPUInfo(
        name="Mock GPU (No NVIDIA detected)",
        vram_total_mb=8192,
        vram_free_mb=6144,
        vram_used_mb=2048,
        temperature=45,
        utilization=0,
        power_draw=None,
    )


def is_real_gpu() -> bool:
    """Return True if a real NVIDIA GPU was detected."""
    return _nvml_available
