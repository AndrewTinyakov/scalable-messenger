plugins {
    kotlin("jvm")
    kotlin("plugin.spring")
    `java-library`
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
    id("org.jooq.jooq-codegen-gradle") version "3.21.7"
}

group = "com.andrewtinyakov"
version = "0.1.0"
java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }
repositories { mavenCentral() }

dependencyManagement { imports { mavenBom("org.springframework.boot:spring-boot-dependencies:4.1.1") } }

dependencies {
    api("org.springframework.boot:spring-boot-starter-jooq")
    api("org.springframework.boot:spring-boot-starter-flyway")
    api("org.flywaydb:flyway-database-postgresql")
    api("tools.jackson.module:jackson-module-kotlin")
    api("com.github.f4b6a3:ulid-creator:5.2.4")
    api("org.postgresql:postgresql")
    implementation("org.springframework:spring-web")
    implementation("io.micrometer:micrometer-core")
    jooqCodegen("org.postgresql:postgresql")
}

kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }
kotlin.sourceSets.named("main") { kotlin.srcDir("src/generated/asyncapi/kotlin") }
sourceSets.main { java.srcDir("src/generated/java") }
ktlint {
    version.set("1.8.0")
    filter { exclude("**/generated/**") }
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
                directory = "${project.projectDir}/src/generated/java"
                encoding = "UTF-8"
                isClean = true
            }
        }
    }
}
