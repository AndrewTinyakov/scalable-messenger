import com.fizzpod.gradle.plugins.osvscanner.OSVScannerInstallTask
import com.fizzpod.gradle.plugins.osvscanner.OSVScannerResolveVersionTask
import org.cyclonedx.gradle.CyclonedxDirectTask

plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21" apply false
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
    id("com.fizzpod.osv-scanner") version "6.2.3"
    id("org.cyclonedx.bom") version "3.5.1"
}

repositories { mavenCentral() }

ktlint { version.set("1.8.0") }

tasks.cyclonedxDirectBom { enabled = false }

osvScanner {
    version.set("v2.7.0")
    format.set("json")
    flags.set("--no-ignore --all-packages")
    failOn.set("exit")
    sbom.set(tasks.cyclonedxBom.flatMap { it.jsonOutput }.map { it.asFile.absolutePath })
}

val osvScannerDirectory = layout.buildDirectory.dir(osvScanner.version.map { "osv-scanner/$it" })

tasks.named<OSVScannerResolveVersionTask>("osvResolveVersion") {
    versionLocation.set(osvScannerDirectory)
}

tasks.named<OSVScannerInstallTask>("osvInstall") {
    osvScannerLocation.set(osvScannerDirectory)
}

tasks.named("osvSbom") { dependsOn(tasks.cyclonedxBom) }

subprojects {
    extra["jackson-bom.version"] = "3.1.7"
    extra["jackson-2-bom.version"] = "2.21.7"
    extra["tomcat.version"] = "11.0.25"
    extra["rabbit-amqp-client.version"] = "5.37.0"

    tasks.named<CyclonedxDirectTask>("cyclonedxDirectBom") {
        includeConfigs = listOf("runtimeClasspath")
    }
}

val plainSqlFixture = sourceSets.create("plainSqlFixture")
val architectureFixture = sourceSets.create("architectureFixture")
val architectureTestSources = sourceSets.create("architectureTest")

dependencies {
    implementation("org.ow2.asm:asm:9.11.1")
    implementation("org.ow2.asm:asm-analysis:9.11.1")
    implementation("org.jetbrains.kotlin:kotlin-compiler-embeddable:2.3.21")
    testImplementation("org.junit.jupiter:junit-jupiter:6.0.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    add(plainSqlFixture.implementationConfigurationName, "org.jooq:jooq:3.21.7")
    add(plainSqlFixture.implementationConfigurationName, "org.springframework:spring-jdbc:7.0.9")
    add(architectureTestSources.implementationConfigurationName, "com.lemonappdev:konsist:0.18.1")
    add(architectureTestSources.implementationConfigurationName, "com.tngtech.archunit:archunit:1.5.1")
    add(architectureTestSources.implementationConfigurationName, "org.jetbrains.kotlin:kotlin-compiler-embeddable:2.3.21")
    add(architectureTestSources.implementationConfigurationName, "org.junit.jupiter:junit-jupiter:6.0.3")
    add(architectureTestSources.runtimeOnlyConfigurationName, "org.junit.platform:junit-platform-launcher")
}

java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }

tasks.test {
    useJUnitPlatform()
    dependsOn(plainSqlFixture.classesTaskName)
    inputs.files(plainSqlFixture.output.classesDirs)
    systemProperty("plainSqlFixture.classes", plainSqlFixture.output.classesDirs.asPath)
    val fixtureJooq = configurations[plainSqlFixture.runtimeClasspathConfigurationName].jooqArtifact()
    inputs.files(fixtureJooq)
    doFirst { systemProperty("plainSqlFixture.jooq", fixtureJooq.singleFile) }
}

fun Configuration.jooqArtifact(): FileCollection = incoming.artifactView {
    componentFilter {
        it is org.gradle.api.artifacts.component.ModuleComponentIdentifier && it.group == "org.jooq" && it.module == "jooq"
    }
}.files

val checkJooqPlainSql = tasks.register<JavaExec>("checkJooqPlainSql") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Reject plain SQL strings sent through jOOQ, JDBC or Spring JDBC outside PostgresStatements"
    javaLauncher.set(javaToolchains.launcherFor(java.toolchain))
    mainClass.set("com.andrewtinyakov.messenger.checks.CheckJooqPlainSqlKt")
    classpath = sourceSets.main.get().runtimeClasspath
    dependsOn(tasks.test)
}

gradle.projectsEvaluated {
    val applicationSourceSets = subprojects.flatMap { project ->
        project.extensions.getByType<SourceSetContainer>().filter {
            it.name in setOf("main", "test", "sidebarBenchmark")
        }
    }
    val jooqArtifacts = files(
        subprojects.flatMap { project ->
            project.extensions.getByType<SourceSetContainer>()
                .filter { it in applicationSourceSets }
                .map { project.configurations[it.runtimeClasspathConfigurationName].jooqArtifact() }
        },
    )
    val firstPartyClasses = files((applicationSourceSets + sourceSets.main.get() + sourceSets.test.get()).map { it.output.classesDirs })
    val productionClasses = files(applicationSourceSets.filter { it.name == "main" }.map { it.output.classesDirs })
    val testClasses = files(applicationSourceSets.filter { it.name != "main" }.map { it.output.classesDirs })
    checkJooqPlainSql.configure {
        inputs.files(jooqArtifacts, firstPartyClasses, fileTree("shared/src/generated/java") { include("**/*.java") })
        doFirst {
            args = listOf(jooqArtifacts.singleFile.absolutePath, rootDir.parentFile.absolutePath) +
                firstPartyClasses.files.filter { it.isDirectory }.map { it.absolutePath }
        }
    }

    val apiMain = project(":api").extensions.getByType<SourceSetContainer>().named("main").get()
    architectureFixture.compileClasspath += apiMain.compileClasspath
    tasks.named<Test>("architectureTest") {
        inputs.files(productionClasses, testClasses, architectureFixture.output.classesDirs)
        doFirst {
            systemProperty("messenger.productionClasses", productionClasses.asPath)
            systemProperty("messenger.testClasses", testClasses.asPath)
            systemProperty("messenger.architectureFixtureClasses", architectureFixture.output.classesDirs.asPath)
        }
    }
}

val repositoryDirectory = layout.projectDirectory.dir("..")
val handwrittenKotlin = repositoryDirectory.asFileTree.matching {
    include("kotlin/**/*.kt", "kotlin/**/*.kts", "tests/sidebar-benchmark/**/*.kt", "tests/sidebar-benchmark/**/*.kts")
    exclude("**/generated/**", "**/.gradle/**", "kotlin/build/**", "kotlin/*/build/**")
}

tasks.register<JavaExec>("checkKotlinComments") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Reject comments in handwritten Kotlin source and build scripts"
    javaLauncher.set(javaToolchains.launcherFor(java.toolchain))
    mainClass.set("com.andrewtinyakov.messenger.checks.CheckKotlinCommentsKt")
    classpath = sourceSets.main.get().runtimeClasspath
    dependsOn(tasks.test)
    inputs.files(handwrittenKotlin)
    workingDir(repositoryDirectory)
    argumentProviders.add(
        CommandLineArgumentProvider {
            handwrittenKotlin.files.map { it.relativeTo(repositoryDirectory.asFile).invariantSeparatorsPath }.sorted()
        },
    )
}

val applicationKotlin = handwrittenKotlin.matching {
    include("kotlin/*/src/main/**/*.kt", "kotlin/*/src/test/**/*.kt", "tests/sidebar-benchmark/**/*.kt")
}

tasks.register<Test>("architectureTest") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Enforce the Messenger Kotlin package and declaration rules"
    useJUnitPlatform()
    testClassesDirs = architectureTestSources.output.classesDirs
    classpath = architectureTestSources.runtimeClasspath
    val fixtureKotlin = layout.projectDirectory.dir("src/architectureFixture/kotlin")
    inputs.files(applicationKotlin, fixtureKotlin)
    systemProperty("messenger.repository", repositoryDirectory.asFile)
    systemProperty("messenger.architectureFixtureSources", fixtureKotlin.asFile)
    doFirst { systemProperty("messenger.architectureFiles", applicationKotlin.asPath) }
}
