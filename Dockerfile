# Render / Docker con Playwright + Chromium
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Playwright ya trae browsers en la imagen base
ENV PLATFORM=cuevana_bio
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "api-server.js"]
