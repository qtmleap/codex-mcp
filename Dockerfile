FROM docker:cli AS docker-cli
FROM node:24.22.1-trixie-slim
ARG CODEX_CLI_VERSION=0.171.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
    && npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
    && mkdir -p /workspace /state && chown node:node /workspace /state \
    && apt-get clean
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/codex-mcp
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
ENV HOST=0.0.0.0 PORT=8879 CODEX_MCP_WORKSPACE=/workspace CODEX_MCP_JOB_DIR=/state/jobs CODEX_MCP_IMAGES_DIR=/state/images
EXPOSE 8879
ENTRYPOINT ["tini", "--", "node", "src/main.mjs"]
CMD ["--transport", "http"]
