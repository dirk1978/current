# The server image (published as ghcr.io/dirk1978/current by .github/workflows/docker.yml). See docker-compose.yml.
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/dirk1978/current" \
      org.opencontainers.image.description="Current: the GB electricity grid and your own home energy (Octopus, Ohme)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY server ./server
COPY web ./web
RUN mkdir -p data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 8092
CMD ["node", "--no-warnings", "server/server.mjs"]
