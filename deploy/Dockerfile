# The relay only. Hosts and guests run Hearth locally - nothing to deploy there.
FROM node:20-alpine

WORKDIR /app
# No dependencies to install: copy the two files the relay actually needs.
COPY relay.js ./relay.js
COPY lib/ws.js ./lib/ws.js
COPY web/app.html ./web/app.html

ENV PORT=8787
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "relay.js"]
