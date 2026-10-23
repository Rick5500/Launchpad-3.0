# One service: the API and the built frontend on PORT.
# Local Windows development does not use this image.
FROM node:22-bookworm-slim

WORKDIR /app

COPY backend/package.json backend/package-lock.json backend/
RUN npm ci --prefix backend

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix frontend

COPY . .
RUN npm run build --prefix frontend && rm -rf frontend/node_modules

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
