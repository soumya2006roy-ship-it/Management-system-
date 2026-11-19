FROM node:22-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV ORION_DB_PATH=/data/orion.db
ENV UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
COPY --chown=node:node *.html *.css *.png ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node services ./services
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "start"]
