FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY prisma ./prisma
RUN bun x prisma generate
COPY src ./src
# The home: config/ holds destinations and the Kingdom pairing; the archive itself is in Postgres.
RUN mkdir /data && chown bun:bun /data
USER bun
ENV PORT=4700
EXPOSE 4700
CMD ["bun", "run", "src/cli.ts", "serve", "--home", "/data", "--hostname", "0.0.0.0"]
