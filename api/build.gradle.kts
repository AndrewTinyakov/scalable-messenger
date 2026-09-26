plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21"
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
    id("org.springdoc.openapi-gradle-plugin") version "1.9.0"
    id("org.jooq.jooq-codegen-gradle") version "3.21.7"
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
    implementation("org.springframework.boot:spring-boot-starter-jooq")
    implementation("org.springframework.boot:spring-boot-starter-amqp")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-flyway")
    implementation("org.flywaydb:flyway-database-postgresql")
    implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("com.github.f4b6a3:ulid-creator:5.2.4")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-api:3.1.1")
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")
    runtimeOnly("org.postgresql:postgresql")
    jooqCodegen("org.postgresql:postgresql")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.testcontainers:postgresql:1.21.3")
    testImplementation("org.testcontainers:junit-jupiter:1.21.3")
}

kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }
kotlin.sourceSets.named("main") { kotlin.srcDir("src/generated/asyncapi/kotlin") }
sourceSets.main { java.srcDir("src/generated/java") }

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
                "--spring.rabbitmq.dynamic=false",
                "--spring.rabbitmq.listener.simple.auto-startup=false",
                "--messenger.role=http",
            ),
        )
    }
}
