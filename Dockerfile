# The engine has no npm dependencies; the image is Node plus the files in src/.
# Base image pinned by digest (node:22-alpine, 2026-11-06) so the same source gives the same image.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    TEE_MODE=dstack \
    TEE_HOST=0.0.0.0 \
    TEE_PORT=3900

USER node
EXPOSE 3900
CMD ["node", "src/server.js"]
