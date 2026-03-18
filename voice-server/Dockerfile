FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js .
EXPOSE 8765
ENV PORT=8765
CMD ["node", "server.js"]
