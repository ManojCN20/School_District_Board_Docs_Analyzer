FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PATH="/opt/venv/bin:$PATH"
ENV NODE_ENV=production
ENV PYTHON_BIN=python3
ENV DATA_ROOT=/app/data

COPY package.json package-lock.json ./
RUN npm ci

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
  && pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

COPY client ./client
COPY server ./server
COPY python-workdir ./python-workdir
COPY README.md ./
COPY .env.example ./
COPY netlify.toml ./

RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]
