# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.gradle ./gradlew :messenger-outbox-publisher:bootJar --no-daemon

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app/messenger-outbox-publisher/build/libs/*.jar app.jar
ENTRYPOINT ["java","-jar","app.jar"]
