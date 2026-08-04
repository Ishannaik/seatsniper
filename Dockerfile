FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.2
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY assets ./assets
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
