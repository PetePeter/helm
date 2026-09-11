// Root project carries no sources — it only declares the plugin versions the
// :app module applies. Keeping plugins `apply false` here is what lets the
// Android toolchain resolve without ever touching the Node build.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
