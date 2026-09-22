FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl \
    && pip3 install --break-system-packages yt-dlp curl-cffi

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
