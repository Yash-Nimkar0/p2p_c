from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("trusted-verifier")

app = FastAPI(title="Trusted Verifier Node")

class EvaluationRequest(BaseModel):
    prompt: str
    provider_response: str

class EvaluationResponse(BaseModel):
    is_valid: bool
    reason: str

@app.post("/evaluate", response_model=EvaluationResponse)
async def evaluate_response(req: EvaluationRequest):
    prompt = req.prompt.lower()
    response = req.provider_response.lower()

    logger.info(f"Evaluating prompt: '{req.prompt}'")

    # If the response is suspiciously short, it's garbage
    if len(response) < 10:
        return EvaluationResponse(is_valid=False, reason="Response too short")

    # Basic semantic heuristics for the MVP challenge prompts
    if "tcp and udp" in prompt:
        if "tcp" in response and "udp" in response and ("connection" in response or "packet" in response):
            return EvaluationResponse(is_valid=True, reason="Semantic match: TCP/UDP")
        return EvaluationResponse(is_valid=False, reason="Failed TCP/UDP semantic check")

    elif "fibonacci" in prompt:
        if "def " in response and ("return" in response or "yield" in response):
            return EvaluationResponse(is_valid=True, reason="Semantic match: Python Fibonacci")
        return EvaluationResponse(is_valid=False, reason="Failed Fibonacci code check")

    elif "french revolution" in prompt:
        if "estate" in response or "monarchy" in response or "taxes" in response or "louis" in response:
            return EvaluationResponse(is_valid=True, reason="Semantic match: French Revolution")
        return EvaluationResponse(is_valid=False, reason="Failed French Revolution historical check")

    elif "french" in prompt and "translate" in prompt:
        if "bonjour" in response or "comment" in response or "allez" in response or "salut" in response:
            return EvaluationResponse(is_valid=True, reason="Semantic match: French translation")
        return EvaluationResponse(is_valid=False, reason="Failed French translation check")

    # Fallback: if it's not a standard challenge prompt, we fail-open for the MVP
    # In production, an actual LLM like Llama-3 8B would grade this.
    logger.warning("Unrecognized prompt. Failing open.")
    return EvaluationResponse(is_valid=True, reason="Unrecognized prompt (fail-open)")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
