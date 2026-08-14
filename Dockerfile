FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=7784
EXPOSE 7784

VOLUME ["/app/data"]

# The container reports unhealthy if the MCP endpoint stops answering, which is
# what "restart: unless-stopped" needs in order to actually help.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/server.js"]
