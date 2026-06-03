FROM node:22-bookworm-slim

RUN apt-get update -qq && apt-get install -y -qq \
  chromium \
  chromium-sandbox \
  unzip \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./

ENV CHROME_PATH=/usr/bin/chromium
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
