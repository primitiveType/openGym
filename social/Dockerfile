FROM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
ARG VCS_REF=dev
LABEL org.opencontainers.image.source="https://github.com/primitiveType/openGym" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app.js model.js store.js server.js ./
USER node
ENV NODE_ENV=production PORT=3100 DATA_DIR=/data
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
