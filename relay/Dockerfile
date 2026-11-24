FROM node:22-slim
WORKDIR /app
COPY --chown=node:node relay /app/relay
RUN mkdir -p /data && chown node:node /data
USER node
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=3333 RELAY_DB=/data/events.sqlite
EXPOSE 3333
CMD ["node", "relay/server.mjs"]
