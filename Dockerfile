FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=7784
EXPOSE 7784

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
