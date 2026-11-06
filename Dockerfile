# The engine has no npm dependencies; the image is Node plus the files in src/.
# Base image pinned by digest (node:22-alpine, 2026-11-06) so the same source gives the same image.
# Reproducible: build with SOURCE_DATE_EPOCH = commit time and rewrite-timestamp (see .github/workflows/image.yml).
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY package.json ./
COPY src ./src

# Hand records stay on the TEE data disk (encrypted with a key only the TEE gets). The volume is mounted here.
RUN mkdir -p /data/records && chown -R node:node /data

# 소스 커밋 — /info 의 commit. 같은 커밋이면 같은 값이라 재현 빌드는 그대로다
ARG GIT_COMMIT=unknown
ENV BUYIN_COMMIT=$GIT_COMMIT

ENV NODE_ENV=production \
    TEE_MODE=dstack \
    TEE_HOST=0.0.0.0 \
    TEE_PORT=3900 \
    TEE_RECORD_DIR=/data/records

USER node
EXPOSE 3900
CMD ["node", "src/server.js"]
