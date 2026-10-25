# syntax=docker/dockerfile:1.7
#
# PPVIO: one image with the Python server and the built front end.
ARG PYTHON_IMAGE=python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534
ARG NODE_IMAGE=node:20-bookworm-slim

# The front end in web/ (React + Vite), served by the player at /.
FROM ${NODE_IMAGE} AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM ${PYTHON_IMAGE} AS runtime
WORKDIR /app
# ffmpeg makes the 480p copies of plain-folder videos (rendition_maker.py).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock ./requirements.lock
RUN python -m pip install \
      --disable-pip-version-check \
      --no-cache-dir \
      --no-build-isolation \
      --no-deps \
      --require-hashes \
      --target /opt/ppvio/site-packages \
      -r requirements.lock \
    && find /opt/ppvio/site-packages -type d -name __pycache__ -prune -exec rm -rf '{}' +

ARG PPVIO_COMMIT=unknown
ARG PPVIO_RELEASE_ID=unreleased
ARG PPVIO_WEB_COMMIT=unknown
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src:/opt/ppvio/site-packages \
    PPVIO_DATA_DIR=/var/lib/ppvio
LABEL org.opencontainers.image.title="ppvio" \
      org.opencontainers.image.revision=${PPVIO_COMMIT} \
      org.opencontainers.image.version=${PPVIO_RELEASE_ID} \
      io.ppvio.web.revision=${PPVIO_WEB_COMMIT}

RUN groupadd --gid 65532 ppvio \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin ppvio
COPY src/ppvio ./src/ppvio
COPY --from=web-build --chown=65532:65532 /web/dist ./web-dist
USER 65532:65532

CMD ["python", "-m", "ppvio.main"]
