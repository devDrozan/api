FROM node:24-alpine AS build
WORKDIR /srv
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /srv
COPY --from=build --chown=node:node /srv/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/dist ./dist
COPY --from=build --chown=node:node /srv/package.json ./package.json
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
