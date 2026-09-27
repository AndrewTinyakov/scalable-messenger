plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21"
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
    id("org.springdoc.openapi-gradle-plugin") version "1.9.0"
    id("org.jooq.jooq-codegen-gradle") version "3.21.7"
    id("com.google.protobuf") version "0.9.4"
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
    jooqCodegen("org.postgresql:postgresql")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation(project(":messenger-command-processor"))
    testImplementation("org.testcontainers:postgresql:1.21.3")
    testImplementation("org.testcontainers:junit-jupiter:1.21.3")
}

kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }

sourceSets.main {
    proto.srcDir("../contracts/grpc")
}

protobuf {
    generatedFilesBaseDir = "$projectDir/src/generated/grpc"
    protoc { artifact = "com.google.protobuf:protoc:4.30.2" }
    plugins { create("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:1.83.1" } }
    generateProtoTasks { all().forEach { it.plugins { maybeCreate("grpc") } } }
}

jooq {
    configuration {
        jdbc {
            driver = "org.postgresql.Driver"
            url = providers.environmentVariable("JOOQ_DB_URL").orElse("jdbc:postgresql://localhost:5432/messenger").get()
            user = providers.environmentVariable("JOOQ_DB_USER").orElse("messenger").get()
            password = providers.environmentVariable("JOOQ_DB_PASSWORD").orElse("messenger").get()
        }
        generator {
            name = "org.jooq.codegen.JavaGenerator"
            database {
                name = "org.jooq.meta.postgres.PostgresDatabase"
                inputSchema = "public"
                includes = ".*"
                excludes = "flyway_schema_history"
            }
            generate {
                isDaos = false
                isPojos = false
                isRecords = true
                isJavaTimeTypes = true
            }
            target {
                packageName = "com.andrewtinyakov.messenger.infrastructure.database.generated"
                directory = "src/generated/java"
                encoding = "UTF-8"
                isClean = true
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
    dependsOn(":shared:jar", ":messenger-command-processor:jar", ":messenger-outbox-publisher:jar")
}

openApi {
    apiDocsUrl.set("http://localhost:18080/api/v3/api-docs.yaml")
    outputDir.set(file("../contracts"))
    outputFileName.set("openapi.yaml")
    customBootRun {
        args.set(
            listOf(
                "--spring.flyway.enabled=false",
                "--server.port=18080",
                "--messenger.grpc.enabled=false",
                "--messenger.auth.ws-ticket-secret=test-ws-ticket-secret-long-enough-for-hmac-2026",
            ),
        )
    }
}
