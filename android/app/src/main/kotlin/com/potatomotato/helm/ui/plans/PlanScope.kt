package com.potatomotato.helm.ui.plans

/**
 * PlanScope — which directory a plan surface is about, decided in one place.
 *
 * Plans are directory-scoped on the desktop, but the phone has TWO ways of
 * arriving at one: an open session brings its own working directory, and the
 * root board brings whichever project the user picked. Resolving that inline in
 * a composable put the decision somewhere no test could reach it, and the case
 * that was wrong — a session with no directory at all — was invisible until it
 * shipped as a permanent spinner.
 *
 * Pure Kotlin, no Compose: this is a rule, and rules belong where a JVM test can
 * pin them.
 */
object PlanScope {

    /**
     * The directory to ask about, or null when there is nothing to ask about.
     *
     * [sessionProjectPath] WINS when it says anything: a session the user has
     * opened has already answered which scope they mean, and falling through to
     * the picked project would show them a different project's board under this
     * session's name.
     *
     * NULL IS A REAL ANSWER, not a missing one. `projectPath` is optional on the
     * desktop and blank on the phone when absent, and a session spawned without
     * one has no plans of its own — the caller must say so rather than wait for
     * an ask that will never be made.
     */
    fun resolve(sessionProjectPath: String?, projectCanonicalPath: String?): String? =
        sessionProjectPath?.takeIf { it.isNotBlank() }
            ?: projectCanonicalPath?.takeIf { it.isNotBlank() }
}
