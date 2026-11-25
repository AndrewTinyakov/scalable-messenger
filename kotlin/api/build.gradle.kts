plugins {
    kotlin("jvm")
    kotlin("plugin.spring")
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
    id("org.springdoc.openapi-gradle-plugin") version "1.9.0"
    id("com.google.protobuf") version "0.10.0"
}

group = "com.andrewtinyakov"
version = "0.1.0"

java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }
repositories { mavenCentral() }

ktlint {
    version.set("1.8.0")
    filter { exclude("**/generated/**") }
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation(project(":shared"))
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-api:3.1.1")
    implementation("io.grpc:grpc-netty-shaded:1.83.1")
    implementation("io.grpc:grpc-protobuf:1.83.1")
    implementation("io.grpc:grpc-stub:1.83.1")
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("io.micrometer:micrometer-registry-prometheus")
    testImplementation(project(":command-processor"))
    testImplementation("org.testcontainers:postgresql:1.21.3")
    testImplementation("org.testcontainers:junit-jupiter:1.21.3")
}

kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }

sourceSets.main {
    proto.srcDir("../../contracts/grpc")
}

protobuf {
    protoc { artifact = "com.google.protobuf:protoc:4.30.2" }
    plugins { create("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:1.83.1" } }
    generateProtoTasks {
        all().forEach { protoTask ->
            protoTask.outputBaseDirProperty.set(layout.projectDirectory.dir("src/generated/grpc/${protoTask.sourceSet.name}"))
            protoTask.plugins { maybeCreate("grpc") }
            protoTask.doLast {
                fileTree(protoTask.outputBaseDirProperty.get().asFile).matching { include("**/*.java") }.forEach { generated ->
                    generated.writeText(generated.readLines().joinToString("\n") { it.trimEnd() } + "\n")
                }
            }
        }
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
    systemProperty("api.version", "1.44")
    systemProperty("messenger.grpc.port", "0")
    environment("WS_TICKET_SECRET", "test-ws-ticket-secret-long-enough-for-hmac-2026")
}

tasks.named("forkedSpringBootRun") {
    dependsOn(":shared:jar", ":command-processor:jar", ":outbox-publisher:jar")
}

val openApiPort = providers.environmentVariable("OPENAPI_PORT").orElse("18080").get()

openApi {
    apiDocsUrl.set("http://127.0.0.1:$openApiPort/api/v3/api-docs.yaml")
    outputDir.set(file("../../contracts"))
    outputFileName.set("openapi.yaml")
    customBootRun {
        args.set(
            listOf(
                "--spring.flyway.enabled=false",
                "--messenger.scheduling.enabled=false",
                "--server.port=$openApiPort",
                "--messenger.grpc.enabled=false",
                "--messenger.ws.ticket-secret=test-ws-ticket-secret-long-enough-for-hmac-2026",
            ),
        )
    }
}

val sidebarBenchmark by sourceSets.creating {
    kotlin.srcDir("../../tests/sidebar-benchmark/kotlin")
    compileClasspath += sourceSets.main.get().output
    runtimeClasspath += sourceSets.main.get().output
}
configurations[sidebarBenchmark.implementationConfigurationName].extendsFrom(configurations.testImplementation.get())
configurations[sidebarBenchmark.runtimeOnlyConfigurationName].extendsFrom(configurations.testRuntimeOnly.get())
tasks.register<Test>("sidebarBenchmark") {
    description = "Measure sidebar queries against an explicitly seeded isolated database"
    testClassesDirs = sidebarBenchmark.output.classesDirs
    classpath = sidebarBenchmark.runtimeClasspath
}
