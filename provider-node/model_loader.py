"""
Model loader — loads a GGUF model file, with auto-download from HuggingFace.

If the model file doesn't exist locally, it's automatically downloaded
with a progress bar using huggingface_hub.
"""

import os
import logging
import time

logger = logging.getLogger("provider.model_loader")

# ──────────────────────────────────────────────
# Default model catalog
# ──────────────────────────────────────────────

DEFAULT_MODELS = {
    "llama-3-8b": {
        "repo_id": "QuantFactory/Meta-Llama-3-8B-Instruct-GGUF",
        "filename": "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf",
        "size_gb": 4.9,
    },
    "phi-3-mini": {
        "repo_id": "microsoft/Phi-3-mini-4k-instruct-gguf",
        "filename": "Phi-3-mini-4k-instruct-q4.gguf",
        "size_gb": 2.4,
    },
    "mistral-7b": {
        "repo_id": "TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
        "filename": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
        "size_gb": 4.4,
    },
}

# ──────────────────────────────────────────────
# Auto-download
# ──────────────────────────────────────────────

def auto_download_model(model_name="llama-3-8b", cache_dir=None):
    """
    Download a model from HuggingFace if not already cached.

    Args:
        model_name: Key in DEFAULT_MODELS catalog.
        cache_dir: Override cache directory (default: ~/.p2p_gpu/models/).

    Returns:
        Absolute path to the downloaded model file.
    """
    if model_name not in DEFAULT_MODELS:
        raise ValueError(f"Unknown model: {model_name}. Available: {list(DEFAULT_MODELS.keys())}")

    info = DEFAULT_MODELS[model_name]
    cache_dir = cache_dir or os.path.expanduser("~/.p2p_gpu/models")
    local_path = os.path.join(cache_dir, info["filename"])

    if os.path.isfile(local_path):
        size_gb = os.path.getsize(local_path) / (1024 ** 3)
        logger.info(f"Model found in cache: {local_path} ({size_gb:.2f} GB)")
        return local_path

    os.makedirs(cache_dir, exist_ok=True)

    logger.info(f"Model not found locally. Downloading from HuggingFace...")
    logger.info(f"  Repo: {info['repo_id']}")
    logger.info(f"  File: {info['filename']} (~{info['size_gb']} GB)")
    logger.info(f"  Cache: {cache_dir}")

    try:
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(
            repo_id=info["repo_id"],
            filename=info["filename"],
            local_dir=cache_dir,
            local_dir_use_symlinks=False,
        )

        logger.info(f"Download complete: {path}")
        return path

    except ImportError:
        raise RuntimeError(
            "huggingface_hub is not installed. "
            "Run: pip install huggingface_hub"
        )
    except Exception as e:
        raise RuntimeError(f"Failed to download model: {e}")


# ──────────────────────────────────────────────
# Model loading
# ──────────────────────────────────────────────

def load_model(model_path: str, n_gpu_layers: int = -1, n_ctx: int = 4096):
    """
    Load a GGUF model file and return a Llama instance.

    If model_path doesn't exist and looks like a model name from the catalog,
    attempts auto-download first.

    Args:
        model_path: Path to .gguf file, or model name for auto-download.
        n_gpu_layers: Number of layers to offload to GPU. -1 = all layers.
        n_ctx: Context window size in tokens.

    Returns:
        A llama_cpp.Llama instance ready for inference.
    """
    # Resolve to absolute path
    model_path = os.path.abspath(model_path)

    if not os.path.isfile(model_path):
        # Try auto-download
        logger.info(f"Model file not found at: {model_path}")
        logger.info("Attempting auto-download from HuggingFace...")
        model_path = auto_download_model()

    file_size_gb = os.path.getsize(model_path) / (1024 ** 3)
    logger.info(f"Loading model: {model_path} ({file_size_gb:.2f} GB)")
    logger.info(f"GPU layers: {n_gpu_layers}, Context window: {n_ctx}")

    try:
        from llama_cpp import Llama

        start = time.monotonic()

        llm = Llama(
            model_path=model_path,
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            verbose=False,
        )

        elapsed = time.monotonic() - start
        logger.info(f"Model loaded successfully in {elapsed:.1f}s")

        return llm

    except ImportError:
        raise RuntimeError(
            "llama-cpp-python is not installed. "
            "Run: pip install llama-cpp-python"
        )
    except Exception as e:
        raise RuntimeError(f"Failed to load model: {e}")


def get_mock_model():
    """
    Return a lightweight mock model object for testing without a GPU.

    The mock model exposes the same create_chat_completion interface
    but returns pre-canned streaming tokens.
    """
    logger.info("Loading MOCK model (no GPU required)")

    class MockLlama:
        """Mimics the llama_cpp.Llama interface for testing."""

        def create_chat_completion(self, messages, stream=False, **kwargs):
            mock_response_text = (
                "Hello! I'm a mock Llama-3 model running in test mode. "
                "This response is simulated to test the P2P inference pipeline "
                "without requiring an actual GPU or model file. "
                "The streaming infrastructure, WebSocket communication, "
                "and token delivery are all being exercised by this mock."
            )

            if not stream:
                return {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": "llama-3-8b",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": mock_response_text,
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": len(mock_response_text.split()),
                        "total_tokens": 10 + len(mock_response_text.split()),
                    },
                }

            # Streaming mode — yield token-by-token chunks
            def _stream():
                words = mock_response_text.split()
                for i, word in enumerate(words):
                    token = word if i == 0 else " " + word
                    yield {
                        "id": "chatcmpl-mock",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": "llama-3-8b",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": token},
                                "finish_reason": None,
                            }
                        ],
                    }

                # Final chunk with finish_reason
                yield {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "llama-3-8b",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": "stop",
                        }
                    ],
                }

            return _stream()

    return MockLlama()
