package com.potatomotato.helm

import android.app.Application

/**
 * Process-wide entry point.
 *
 * Intentionally empty: the BLE peripheral (P-0741), the secure channel
 * (P-0742) and their foreground service are owned by later plans. This exists
 * now so those plans have a single place to hang process-scoped singletons
 * instead of each inventing one.
 */
class HelmApp : Application()
