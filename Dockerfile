FROM node:20-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
