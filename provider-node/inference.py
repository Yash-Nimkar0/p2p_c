"""
Inference wrapper — converts llama-cpp-python output into
OpenAI-compatible streaming chunks.
"""

import asyncio
import json
import time
import uuid
import logging
from typing import AsyncGenerator

import config

logger = logging.getLogger("provider.inference")


async def stream_chat_completion(
    llm, messages: list[dict], request_id: str | None = None
) -> AsyncGenerator[dict, None]:
    """
    Run streaming inference and yield OpenAI-format chunk dictionaries.

    This function wraps the synchronous llama-cpp-python generator in an
    async generator, yielding each token as an OpenAI SSE chunk.

    Args:
        llm: A Llama instance (real or mock).
        messages: The chat messages array (OpenAI format).
        request_id: Optional request ID for tracing.

    Yields:
        dict: OpenAI-format chunk objects with delta content.
    """
    if request_id is None:
        request_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    created = int(time.time())
    token_count = 0
    start_time = time.monotonic()

    logger.info(
        f"[{request_id}] Starting inference | "
        f"messages={len(messages)} | "
        f"last_msg_len={len(messages[-1].get('content', '')) if messages else 0}"
    )

    try:
        # llama-cpp-python's create_chat_completion with stream=True
        # returns a synchronous generator — run it in a thread executor
        # to avoid blocking the async event loop.
        stream = llm.create_chat_completion(
            messages=messages,
            stream=True,
        )

        first_token_time = None

        for chunk in stream:
            # In mock mode, add a small delay between tokens
            if config.MOCK_MODE:
                await asyncio.sleep(config.MOCK_TOKEN_DELAY)
            else:
                # Yield control to the event loop between tokens
                await asyncio.sleep(0)

            choices = chunk.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            finish_reason = choices[0].get("finish_reason")

            if first_token_time is None and "content" in delta:
                first_token_time = time.monotonic()
                ttft = first_token_time - start_time
                logger.info(f"[{request_id}] First token in {ttft:.3f}s")

            if "content" in delta:
                token_count += 1

            oai_chunk = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": config.MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": delta,
                        "finish_reason": finish_reason,
                    }
                ],
            }

            yield oai_chunk

            if finish_reason is not None:
                break

        elapsed = time.monotonic() - start_time
        tps = token_count / elapsed if elapsed > 0 else 0

        logger.info(
            f"[{request_id}] Inference complete | "
            f"tokens={token_count} | "
            f"elapsed={elapsed:.2f}s | "
            f"tokens/s={tps:.1f}"
        )

    except Exception as e:
        logger.error(f"[{request_id}] Inference error: {e}")
        raise


async def run_non_streaming(llm, messages: list[dict], request_id: str | None = None) -> dict:
    """
    Run non-streaming inference and return a complete OpenAI-format response.

    Args:
        llm: A Llama instance (real or mock).
        messages: The chat messages array (OpenAI format).
        request_id: Optional request ID for tracing.

    Returns:
        dict: Complete OpenAI-format chat completion response.
    """
    if request_id is None:
        request_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    logger.info(f"[{request_id}] Starting non-streaming inference")
    start_time = time.monotonic()

    try:
        # Run synchronous inference in executor to not block event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: llm.create_chat_completion(messages=messages, stream=False),
        )

        # Normalize the response format
        result["id"] = request_id
        result["model"] = config.MODEL_NAME

        elapsed = time.monotonic() - start_time
        logger.info(f"[{request_id}] Non-streaming inference complete in {elapsed:.2f}s")

        return result

    except Exception as e:
        logger.error(f"[{request_id}] Non-streaming inference error: {e}")
        raise
