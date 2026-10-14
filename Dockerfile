# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PURSESTRING_HOME=/data \
    PURSESTRING_POLICY=/config/policies.yaml \
    PURSESTRING_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY examples ./examples
COPY examples/policies.yaml /config/policies.yaml
RUN mkdir -p /data && chown -R node:node /data /config && ln -s /app/dist/index.js /usr/local/bin/pursestring && chmod +x /app/dist/index.js
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["serve"]
