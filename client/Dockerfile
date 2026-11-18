FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.30.5-alpine
COPY nginx.conf /opt/messenger/nginx.conf
COPY --chmod=755 configure-runtime.sh /docker-entrypoint.d/40-configure-runtime.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
