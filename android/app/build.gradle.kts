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
val keyAlias = signingValue("helm.key.alias", "HELM_KEY_ALIAS")
val keyPassword = signingValue("helm.key.password", "HELM_KEY_PASSWORD")
val hasReleaseSigning = listOf(keystorePath, keystorePassword, keyAlias, keyPassword).all { !it.isNullOrBlank() }

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
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
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

dependencies {
    implementation(libs.bouncycastle)
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
