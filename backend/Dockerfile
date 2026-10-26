# One image, four roles chosen by command in the stack: the API (default),
# ingest, retention and the retired Kafka sink. Python 3.12: confluent-kafka
# 2.4 has no newer wheels.
FROM python:3.12.14-slim-trixie

# Debian security fixes land between base image releases; CI's Trivy gate
# fails on fixable HIGH and CRITICAL findings.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN adduser --disabled-password --gecos '' appuser

COPY requirements.txt .
# pip leaves after installing: it vendors its own certifi, msgpack and urllib3,
# which Trivy flags, and nothing here installs at runtime.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip check \
 && pip uninstall -y pip setuptools wheel \
 && rm -rf /root/.cache /usr/local/lib/python3*/ensurepip

COPY buoys/ ./buoys/
COPY tools/ ./tools/
COPY tests/ ./tests/

ARG COMMIT=unknown
ENV COMMIT=$COMMIT PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER appuser
EXPOSE 8000
# For the API role. The stack turns it off for the worker roles, which serve no HTTP.
# /api/health answers 200 whenever the process is up, even with CouchDB down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "buoys.main:app", "--host", "0.0.0.0", "--port", "8000"]
