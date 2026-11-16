FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test ./test
COPY knowledge.md ./
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "src/server.ts"]
