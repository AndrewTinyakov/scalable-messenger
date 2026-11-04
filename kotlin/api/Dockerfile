# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk AS build
WORKDIR /app/kotlin
COPY kotlin/ .
COPY contracts/grpc/ /app/contracts/grpc/
RUN --mount=type=cache,target=/root/.gradle,sharing=locked ./gradlew :api:bootJar --no-daemon

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app/kotlin/api/build/libs/*.jar app.jar
EXPOSE 8080 9090
USER 10001:10001
ENTRYPOINT ["java","-jar","app.jar"]
