# syntax=docker/dockerfile:1
FROM gradle:8.14.3-jdk21 AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.gradle ./gradlew bootJar --no-daemon

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]
