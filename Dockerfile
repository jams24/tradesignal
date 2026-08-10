FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma/ prisma/
COPY tsconfig.json ./
COPY src/ src/

RUN npx prisma generate \
    && npm run build \
    && npm prune --production

EXPOSE 3000

CMD ["node", "--max-old-space-size=512", "dist/index.js"]
