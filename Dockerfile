FROM node:20-alpine

WORKDIR /app

# copy package.json + lock
COPY package*.json ./
RUN npm ci --only=production

# copy source
COPY . .

ENV PORT=3000
ENV SESSION_DIR=/app/auth

EXPOSE 3000
CMD ["node", "index.mjs"]
