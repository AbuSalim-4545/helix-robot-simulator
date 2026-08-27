FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000 9090

ENV NODE_ENV=production
ENV MQTT_HOST=wss://d0198e38be3049bd878bc42799f52885.s1.eu.hivemq.cloud:8884/mqtt
ENV MQTT_USER=hivemq.webclient.1773177445105
ENV MQTT_PASS=15apW02MK,%A*gOdy;Tw

CMD ["node", "server.js"]
