FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
