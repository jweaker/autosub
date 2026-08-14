FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No dependency runs an install script; blocking them keeps a compromised
# package from executing during the build.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="AutoSub" \
      org.opencontainers.image.description="Audio-validated, automatically synchronized subtitles for Stremio" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/autosub-venv
COPY requirements-vad.txt /tmp/requirements-vad.txt
RUN /opt/autosub-venv/bin/pip install --no-cache-dir -r /tmp/requirements-vad.txt
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PYTHON_PATH=/opt/autosub-venv/bin/python \
    VAD_SCRIPT_PATH=/app/scripts/vad.py
USER node
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
