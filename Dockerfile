FROM node:20-alpine

WORKDIR /app

# 仅依赖清单，便于利用层缓存
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js imposition.js preflight.js pagenumbers.js fonts.js imageresolution.js bleedboxes.js annotations.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
