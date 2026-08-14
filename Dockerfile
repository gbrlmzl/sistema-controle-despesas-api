# syntax=docker/dockerfile:1

# Debian (glibc), não Alpine (musl): bcrypt é nativo e tem prebuild mais confiável em glibc,
# evitando precisar de toolchain de compilação (python3/make/g++) na imagem — ver seção 12.1
# de docs/plano-api-node-express.md.
ARG NODE_VERSION=24-bookworm-slim

# ---- deps: todas as dependências (dev + prod) — reaproveitada pelos estágios build e migrate ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# O schema-engine do Prisma (usado por `migrate deploy`) é um binário nativo que depende de
# libssl — a imagem slim não traz OpenSSL por padrão, sem isso o generate avisa e o migrate
# real pode falhar em runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: gera o Prisma Client e compila o TypeScript ----
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# `prisma generate` só lê o schema, não conecta no banco — mas prisma.config.ts carrega essa env
# var no import, então precisa de algum valor presente para não quebrar aqui.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npm run build

# ---- prod-deps: só as dependências de produção, para a imagem final ficar enxuta ----
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: imagem final que sobe em produção ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 3001

# Reusa GET /health — evita instalar curl só para o healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
