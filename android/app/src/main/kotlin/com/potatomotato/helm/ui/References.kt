package com.potatomotato.helm.ui

import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.data.HelmPlanSummary

/**
 * The text the ⧉ button on a detail screen puts on the clipboard.
 *
 * Why an id rather than a title: the point is a reference the user can paste at
 * a desktop session and have resolve to the same item there, and ids are the
 * only thing both ends agree on. Plans prefer their HUMAN id (P-00xx) — it is
 * what the desktop's own surfaces name them by — falling back to the uuid for
 * the plans that have no P-00xx yet.
 */
object HelmReferences {

    /** The stable reference for a plan on the board. */
    fun plan(plan: HelmPlanSummary): String = plan.humanId ?: plan.id

    /** The stable reference for an artifact. */
    fun artifact(artifact: HelmArtifact): String = artifact.id

    /** The stable reference for a context node. */
    fun context(context: HelmContext): String = context.id
}
