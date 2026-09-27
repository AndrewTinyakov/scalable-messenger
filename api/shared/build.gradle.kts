plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21"
    `java-library`
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
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
}

kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }
kotlin.sourceSets.named("main") { kotlin.srcDir("../src/generated/asyncapi/kotlin") }
sourceSets.main { java.srcDir("../src/generated/java") }
ktlint {
    version.set("1.8.0")
    filter { exclude("**/generated/**") }
}
