# syntax=docker/dockerfile:1.7
# EnsoCode 无界面宿主：同一条流水线产出 systemd 安装包（--target bundle-out）与 Docker 镜像（默认目标，内置 relay-go）
FROM node:24-bookworm AS deps
ENV CI=1
RUN corepack enable
WORKDIR /src
# 先只拷清单，源码改动不重装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/pair/package.json packages/pair/
COPY packages/phone/package.json packages/phone/
COPY packages/relay/package.json packages/relay/

FROM deps AS build
# 根 postinstall 会下载 Electron；服务端跳过脚本，只构建用得到的原生依赖
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild esbuild
# rtk 按清单下载并校验，单独成层，源码改动不重复拉
COPY scripts/rtk.mjs scripts/prepare-rtk.mjs scripts/
COPY resources/rtk/manifest.json resources/rtk/
RUN node scripts/prepare-rtk.mjs && cp resources/rtk/linux-*/rtk resources/rtk/rtk
COPY . .
RUN pnpm build && pnpm exec vite build -c vite.server.config.ts \
 && pnpm --filter @enso/phone build

# 只装生产依赖并按 Node ABI 构建原生模块（服务端产物把依赖全部 external）
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts \
 && pnpm rebuild node-pty better-sqlite3 node-datachannel @vscode/ripgrep

FROM deps AS bundle
WORKDIR /bundle
COPY --from=prod-deps /src/package.json ./
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=prod-deps /src/packages ./packages
COPY --from=build /src/out/server ./out/server
COPY --from=build /src/out/renderer ./out/renderer
COPY --from=build /src/resources/rtk/rtk ./resources/rtk/rtk
COPY deploy/server/enso-server ./bin/enso-server
COPY deploy/server/enso-server.service ./share/enso-server.service
RUN cp "$(command -v node)" bin/node \
 && node -p "require('./package.json').version" > VERSION \
 && find out -name '*.map' -delete \
 && chmod +x bin/enso-server bin/node

FROM bundle AS bundle-tar
RUN tar -czf /enso-server.tar.gz -C /bundle .

FROM scratch AS bundle-out
COPY --from=bundle-tar /enso-server.tar.gz /

FROM golang:1.25-bookworm AS relay
WORKDIR /src
COPY packages/relay-go/go.mod packages/relay-go/go.sum ./
RUN go mod download
COPY packages/relay-go/ ./
COPY --from=build /src/packages/phone/dist ./frontend
COPY --from=build /src/out/renderer ./frontend/desk-bundle
RUN find frontend/desk-bundle -name '*.map' -delete \
 && CGO_ENABLED=0 go build -o /out/enso-relay .

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps bash openssh-client curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bundle /bundle /app
COPY --from=relay /out/enso-relay /usr/local/bin/enso-relay
RUN ln -s /app/bin/enso-server /usr/local/bin/enso-server \
 && ln -s /app/bin/node /usr/local/bin/node
ARG VERSION=dev
LABEL org.opencontainers.image.title="EnsoCode Server" \
      org.opencontainers.image.source="https://github.com/J3n5en/EnsoCode" \
      org.opencontainers.image.version="$VERSION"
ENV ENSO_DATA_DIR=/data ENSO_UPDATE_MODE=docker
VOLUME ["/data", "/workspace"]
CMD ["enso-server"]
