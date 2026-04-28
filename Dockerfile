FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_ROOT=/app/data

COPY package.json package-lock.json ./
RUN npm install

COPY client ./client
COPY server ./server
COPY README.md ./
COPY .env.example ./
COPY netlify.toml ./

RUN npm run setup:browser
RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]
