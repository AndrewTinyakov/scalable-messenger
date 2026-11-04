import com.fizzpod.gradle.plugins.osvscanner.OSVScannerInstallTask
import com.fizzpod.gradle.plugins.osvscanner.OSVScannerResolveVersionTask
import org.cyclonedx.gradle.CyclonedxDirectTask

plugins {
    base
    kotlin("jvm") version "2.3.21" apply false
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
