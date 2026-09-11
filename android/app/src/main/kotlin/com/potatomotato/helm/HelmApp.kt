package com.potatomotato.helm

import android.app.Application
import com.potatomotato.helm.link.HelmPairing

/**
 * Process-wide entry point, and the single place process-scoped singletons are
 * started — so no screen or service has to wonder whether it is the first one in.
 */
class HelmApp : Application() {
    override fun onCreate() {
        super.onCreate()
        HelmPairing.init(this)
    }
}
