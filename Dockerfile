FROM node:20-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install --only=production
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
