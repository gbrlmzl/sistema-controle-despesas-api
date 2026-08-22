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
# Mesma lib nativa que o estágio deps precisa — o schema-engine do Prisma
# (usado por `migrate deploy`, rodado a partir desta mesma imagem no serviço
# migrate) depende dela e essa imagem não herda o apt-get do estágio deps.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# --chown=node:node: os estágios anteriores rodam como root, e o Prisma
# baixa/escreve os binários da engine em node_modules/@prisma/engines na
# primeira execução do `migrate deploy` — sem isso, o container (que roda
# como "node" logo abaixo) não tem permissão de escrita e o migrate falha
# com "Can't write to .../@prisma/engines".
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
# schema.prisma + migrations precisam existir em runtime: `migrate deploy` os
# lê diretamente, não usa o Prisma Client já gerado em dist/.
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node prisma ./prisma

USER node
EXPOSE 8080

# Reusa GET /health — evita instalar curl só para o healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
