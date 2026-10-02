FROM node:24-alpine AS frontend
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TENDERLENS_DATA_DIR=/app/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml README.md ./
COPY backend/ ./backend/
RUN pip install --no-cache-dir . && useradd --create-home --uid 10001 app \
    && mkdir -p /app/data && chown -R app:app /app
COPY --from=frontend /web/dist ./frontend/dist
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
CMD ["uvicorn", "tenderlens.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
