# syntax=docker/dockerfile:1.7
# EnsoCode 无界面宿主 + 自带中继（relay-go 内置手机 PWA 与桌面 renderer 产物）
FROM node:24-bookworm AS build
ENV CI=1
RUN corepack enable
WORKDIR /src
# 先只拷清单，源码改动不重装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/pair/package.json packages/pair/
COPY packages/phone/package.json packages/phone/
COPY packages/relay/package.json packages/relay/
# 根 postinstall 会下载 Electron；服务端跳过脚本，只构建 Node ABI 的原生依赖（rg 用系统包）
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild esbuild node-pty better-sqlite3 node-datachannel protobufjs
COPY . .
RUN pnpm build && pnpm exec vite build -c vite.server.config.ts \
 && pnpm --filter @enso/phone build
# 服务端按打包布局取 resources/rtk/rtk
RUN node scripts/prepare-rtk.mjs && cp resources/rtk/linux-*/rtk resources/rtk/rtk

FROM golang:1.25-bookworm AS relay
WORKDIR /src
COPY packages/relay-go/go.mod packages/relay-go/go.sum ./
RUN go mod download
COPY packages/relay-go/ ./
COPY --from=build /src/packages/phone/dist ./frontend
COPY --from=build /src/out/renderer ./frontend/desk-bundle
RUN find frontend/desk-bundle -name '*.map' -delete \
 && CGO_ENABLED=0 go build -o /out/enso-relay .

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps bash ripgrep openssh-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/out ./out
COPY --from=build /src/resources ./resources
COPY --from=relay /out/enso-relay /usr/local/bin/enso-relay
RUN for d in node_modules/.pnpm/@vscode+ripgrep@*/node_modules/@vscode/ripgrep; do \
      mkdir -p "$d/bin" && ln -sf /usr/bin/rg "$d/bin/rg"; done \
 && printf '#!/bin/sh\nexec node /app/out/server/index.js "$@"\n' > /usr/local/bin/enso-server \
 && chmod +x /usr/local/bin/enso-server
ENV ENSO_DATA_DIR=/data
VOLUME ["/data", "/workspace"]
CMD ["enso-server"]
