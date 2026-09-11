package com.potatomotato.helm

import org.json.JSONObject
import java.io.File

/**
 * The committed cross-language vectors, read IN PLACE from tests/fixtures/.
 *
 * They are never copied into android/: a copy is a second source of truth
 * waiting to drift, which is the exact failure mode the vector scheme exists to
 * prevent. The directory arrives as the `helm.fixtures.dir` system property; see
 * android/app/build.gradle.kts.
 */
fun loadFixture(name: String): JSONObject {
    val dir = System.getProperty("helm.fixtures.dir")
        ?: error("helm.fixtures.dir is not set; see android/app/build.gradle.kts")
    val file = File(dir, name)
    check(file.isFile) { "missing conformance vectors at ${file.absolutePath}" }
    return JSONObject(file.readText())
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

fun String.fromHex(): ByteArray =
    ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
