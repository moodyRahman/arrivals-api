FROM node:26-trixie-slim

ENV NODE_ENV=production
WORKDIR /app

# Node 25+ images no longer bundle yarn
RUN npm install -g yarn@1.22.22

# Install dependencies first for better layer caching
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Copy the app source
COPY index.js draw.html ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://localhost:3000/api/pixels').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "index.js"]