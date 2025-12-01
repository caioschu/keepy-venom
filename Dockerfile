FROM node:18-slim

# Instala dependências do Chromium para o Venom
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Define variável para o Puppeteer usar o Chromium instalado
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copia package.json primeiro (melhor cache)
COPY package*.json ./

# Instala dependências
RUN npm install --production

# Copia resto do código
COPY . .

# Expõe porta
EXPOSE 3000

# Inicia
CMD ["npm", "start"]
