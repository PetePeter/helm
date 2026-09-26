import java.net.URI
import javax.inject.Inject
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

/**
 * The app version is DERIVED from Helm's own package.json, never hand-edited.
 *
 * Android refuses to install an APK whose versionCode is lower than the
 * installed one, so a forgotten manual bump is a silent trap that only shows up
 * on a user's phone. prepareDeploy.py already bumps package.json on every
 * release; reading it here makes that the single source of truth.
 *
 * This is plain text parsing on purpose — the Android build must not require
 * Node to be installed.
 */
val helmVersionName: String = run {
    val pkg = rootProject.file("../package.json")
    val match = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(pkg.readText())
        ?: throw GradleException("Could not read \"version\" from ${pkg.absolutePath}")
    match.groupValues[1]
}

val helmVersionCode: Int = run {
    val parts = helmVersionName.split(".", "-")
    val major = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val patch = parts.getOrNull(2)?.toIntOrNull() ?: 0
    major * 10000 + minor * 100 + patch
}

/**
 * Release signing material never lives in the working tree (invariant 4).
 * It comes from android/local.properties, or from the environment for CI.
 */
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(key: String, env: String): String? =
    localProperties.getProperty(key) ?: System.getenv(env)

val keystorePath = signingValue("helm.keystore.file", "HELM_KEYSTORE_FILE")
val keystorePassword = signingValue("helm.keystore.password", "HELM_KEYSTORE_PASSWORD")
// Deliberately NOT named keyAlias/keyPassword: inside signingConfigs.create the
// receiver has properties of those names, so `this.keyAlias = keyAlias` reads the
// receiver's own null back into itself and the release config silently loses its
// key while still reporting as configured.
val releaseKeyAlias = signingValue("helm.key.alias", "HELM_KEY_ALIAS")
val releaseKeyPassword = signingValue("helm.key.password", "HELM_KEY_PASSWORD")
val hasReleaseSigning = listOf(keystorePath, keystorePassword, releaseKeyAlias, releaseKeyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "com.potatomotato.helm"
    compileSdk = 35

    defaultConfig {
        // PERMANENT. Changing this is not an update — it installs as a second
        // app and the user loses their pairing. See android/README.md.
        applicationId = "com.potatomotato.helm"
        minSdk = 26
        targetSdk = 35
        versionCode = helmVersionCode
        versionName = helmVersionName
        // Vosk ships ~9 MB of native code PER ABI; phones are ARM, so the x86
        // (emulator) and legacy mips/armeabi copies are ~19 MB of dead weight.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = releaseKeyAlias
                this.keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without configured release material the build still produces an
            // installable APK under the debug key, so a contributor can build
            // without holding the permanent release key. Only the key backed up
            // per android/README.md may sign a public release.
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                logger.warn(
                    // ASCII only: Gradle's console encoding mangles non-ASCII on Windows.
                    "WARNING: no release signing material configured - signing assembleRelease " +
                        "with the DEBUG key. This APK must not be published. See android/README.md."
                )
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
        // HelmLog gates verbose/debug on BuildConfig.DEBUG so a release build is
        // quiet without anyone having to remember. AGP 8 does not generate
        // BuildConfig unless asked.
        buildConfig = true
    }
}

/**
 * The BLE wire format is shared with the desktop, and a mismatch fails silently
 * as "pairing just never works". The Kotlin unit tests therefore assert against
 * the SAME committed vectors the TypeScript side asserts against, read in place
 * rather than copied — a copy is a second source of truth waiting to drift.
 */
tasks.withType<Test>().configureEach {
    systemProperty("helm.fixtures.dir", rootProject.file("../tests/fixtures").absolutePath)
    // The design system is only enforceable if a test can read the sources it
    // governs; see NoRawColorLiteralTest.
    systemProperty("helm.android.src.dir", file("src/main/kotlin").absolutePath)
}

/**
 * The Vosk model for "Hey Helm" (~40 MB) is DOWNLOADED at build time into the
 * build dir rather than checked in: a binary that size does not belong in git.
 * Fetched once and cached under build/vosk; the assets carry a `uuid` file,
 * which is what StorageService.unpack compares to decide whether the copy in
 * filesDir is current — bump [voskModelName] and phones re-unpack.
 */
val voskModelName = "vosk-model-small-en-us-0.15"

abstract class VoskModelTask : DefaultTask() {
    @get:Input abstract val modelName: Property<String>
    @get:Internal abstract val cacheDir: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations
    @get:Inject abstract val archives: ArchiveOperations

    @TaskAction
    fun unpack() {
        val name = modelName.get()
        val zipFile = cacheDir.file("$name.zip").get().asFile
        if (!zipFile.exists()) {
            zipFile.parentFile.mkdirs()
            val part = File(zipFile.path + ".part")
            URI("https://alphacephei.com/vosk/models/$name.zip").toURL().openStream().use { input ->
                part.outputStream().use { input.copyTo(it) }
            }
            check(part.renameTo(zipFile)) { "could not move ${part.name} into place" }
        }
        val dest = outputDir.dir("model-en-us").get().asFile
        fs.delete { delete(outputDir) }
        fs.copy {
            from(archives.zipTree(zipFile))
            into(dest)
            // Drop the zip's top-level folder: the assets dir IS the model.
            eachFile { relativePath = RelativePath(true, *relativePath.segments.drop(1).toTypedArray()) }
            includeEmptyDirs = false
        }
        File(dest, "uuid").writeText(name)
    }
}

val voskModel = tasks.register<VoskModelTask>("voskModel") {
    description = "Downloads and unpacks the Vosk wake-word model into generated assets."
    modelName.set(voskModelName)
    cacheDir.set(layout.buildDirectory.dir("vosk"))
}
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(voskModel, VoskModelTask::outputDir)
    }
}

dependencies {
    implementation(libs.bouncycastle)
    implementation(libs.vosk.android) { artifact { type = "aar" } }
    implementation(libs.jna) { artifact { type = "aar" } }
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
