FROM python:3.12-slim

WORKDIR /app

RUN adduser --disabled-password --gecos '' appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY buoys/ ./buoys/

USER appuser

CMD ["uvicorn", "buoys.main:app", "--host", "0.0.0.0", "--port", "8000"]
