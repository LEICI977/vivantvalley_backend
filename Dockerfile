FROM node:22-alpine
WORKDIR /app
COPY package.json server.js smoke-test.mjs ./
COPY *.md openapi.yaml ./
COPY public ./public
COPY imagegen ./imagegen
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "server.js"]
