FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8081/api
ARG VITE_WS_URL=ws://localhost:8082/ws
RUN npm run build
RUN node configure-nginx.mjs > /app/nginx.generated.conf

FROM nginx:1.30.5-alpine
COPY --from=build /app/nginx.generated.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
