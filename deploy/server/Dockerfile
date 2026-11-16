# The live Suplex site: the web app, the API and the AI service on one port (serve.py).
# Built from the folder deploy/publish.py stages, which holds this file next to the code and web/dist.
# The city data is not in the image. It lives on the Fly volume mounted at /data (fly.toml).
FROM python:3.14-slim

WORKDIR /app

# The packages first, so a code-only change reuses this layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

CMD ["python", "-m", "uvicorn", "serve:app", "--host", "0.0.0.0", "--port", "8080"]
