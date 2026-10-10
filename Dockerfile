# ---- deps: install with pnpm ----
FROM node:24-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@12
COPY package.json pnpm-workspace.yaml* ./
# PR3: @prisma/client's postinstall runs `prisma generate`, which validates the
# datasource and aborts with P1012 "Environment variable not found:
# DATABASE_URL" even though it never opens a connection. .env is excluded by
# .dockerignore, so the build needs a placeholder. Build-time only, never used
# to reach a database: the real URL arrives at runtime from compose.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL
RUN pnpm install --no-frozen-lockfile

# ---- builder: compile Next.js standalone ----
FROM node:24-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@12
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p ./public && pnpm build

# ---- runner: minimal production image ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
