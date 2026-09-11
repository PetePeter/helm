package com.potatomotato.helm

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

/**
 * "Which of these has the user actually granted?" — asked the same way
 * everywhere, so a second permission gate cannot answer it differently from the
 * first. The lists themselves stay with the feature that needs them.
 */
object Permissions {
    fun missing(context: Context, required: List<String>): List<String> = required.filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun allGranted(context: Context, required: List<String>): Boolean =
        missing(context, required).isEmpty()
}
