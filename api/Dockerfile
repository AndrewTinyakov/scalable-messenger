# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk AS build
WORKDIR /app/api
COPY api/ .
COPY contracts/grpc/ /app/contracts/grpc/
RUN --mount=type=cache,target=/root/.gradle ./gradlew :bootJar --no-daemon

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app/api/build/libs/*.jar app.jar
EXPOSE 8080 9090
ENTRYPOINT ["java","-jar","app.jar"]
