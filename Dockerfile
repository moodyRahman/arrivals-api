FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Copy the app source
COPY index.js draw.html ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/api/pixels >/dev/null || exit 1

CMD ["node", "index.js"]