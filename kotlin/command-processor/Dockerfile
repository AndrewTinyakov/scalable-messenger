# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk AS build
WORKDIR /app/kotlin
COPY kotlin/ .
RUN --mount=type=cache,target=/root/.gradle,sharing=locked ./gradlew :command-processor:bootJar --no-daemon

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app/kotlin/command-processor/build/libs/*.jar app.jar
USER 10001:10001
ENTRYPOINT ["java","-jar","app.jar"]
