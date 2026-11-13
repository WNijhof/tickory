# syntax=docker/dockerfile:1
# Persoonlijke takenapp: één container met de sync-server en de web-app.
# Geen build-stap en geen npm-pakketten: Node voert de TypeScript zelf uit en SQLite zit in Node.
FROM node:26-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/todo.db

WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client

# De database staat in een volume. Het eigendom ligt bij de niet-bevoorrechte gebruiker "node" (uid 1000);
# de rest van /app blijft van root en is dus niet beschrijfbaar voor de app zelf.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/main.ts"]
