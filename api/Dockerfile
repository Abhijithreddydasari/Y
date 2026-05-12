# FastAPI backend image. The container does NOT include Ollama or the model -
# those run on the host; the container talks to them via OLLAMA_HOST.
#
# Build from the REPO ROOT so we can copy api/ and schema/ in one go:
#     docker build -f api/Dockerfile -t y-api .
#     docker run --rm -p 8000:8000 \
#         -e OLLAMA_HOST=http://host.docker.internal:11434 \
#         -e MODEL_NAME=gemma4:e4b \
#         y-api
FROM python:3.11-slim AS deps
WORKDIR /app
RUN pip install --no-cache-dir uv==0.5.* && \
    apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY api/pyproject.toml api/uv.lock* ./
RUN uv venv && uv sync --no-dev

FROM python:3.11-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    OLLAMA_HOST=http://host.docker.internal:11434 \
    MODEL_NAME=gemma4:e4b \
    API_HOST=0.0.0.0 \
    API_PORT=8000

COPY api/ /app/
COPY schema/ /schema/

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
