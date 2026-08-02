FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so code edits don't invalidate the npm layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# The deck is baked into the image — build it with `npm run fetch-cards`
# before deploying so the container never has to call the museum APIs.
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0

# Run unprivileged.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
