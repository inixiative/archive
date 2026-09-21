FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
RUN mkdir /data && chown bun:bun /data
ENV PORT=4411
EXPOSE 4411
CMD ["bun", "run", "src/cli.ts", "serve", "--home", "/data", "--hostname", "0.0.0.0"]
