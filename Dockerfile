FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Berlin

RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY views ./views

RUN mkdir -p /data && chown -R node:node /data
USER node

# Hier liegen Datenbank und Cover. In Coolify als Persistent Storage einbinden!
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
