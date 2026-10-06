# 野外实验站离线记录：零依赖 Node 20 运行镜像
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY test ./test
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

# 健康检查：编排内健康响应冒烟
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/main.js"]
