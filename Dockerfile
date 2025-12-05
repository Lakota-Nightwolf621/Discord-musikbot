# Wir nutzen 'bookworm', das ist der Codename für das aktuelle Debian 12.
# Alternativ kannst du 'node:20-bookworm-slim' nutzen, um das Image kleiner zu halten.
FROM node:20-bookworm

WORKDIR /app

COPY package.json ./

RUN npm install --only=production

COPY src ./src
COPY public ./public

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]