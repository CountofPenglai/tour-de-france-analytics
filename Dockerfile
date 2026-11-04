# Official multi-platform Python image, pinned to an immutable index digest.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.lock.txt ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --index-url https://pypi.org/simple -r requirements.lock.txt \
    && python -m pip check
COPY web ./web
COPY scripts ./scripts
COPY sql ./sql
COPY data ./data
COPY deploy ./deploy
COPY tests ./tests
COPY start.sh ./start.sh
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "deploy.portal"]
