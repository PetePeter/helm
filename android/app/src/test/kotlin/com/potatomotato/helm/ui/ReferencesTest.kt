package com.potatomotato.helm.ui

import com.potatomotato.helm.data.ContextPermission
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.PlanStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the ⧉ button puts on the clipboard for each kind of detail screen.
 *
 * Every reference carries its KIND as well as its id: what is pasted has to say
 * what it is, since the ids alone do not tell each other apart.
 */
class ReferencesTest {

    @Test
    fun `a plan copies its human id`() {
        assertEquals("[helm plan P-0007]", HelmReferences.plan(plan(humanId = "P-0007")))
    }

    @Test
    fun `a plan without a human id falls back to its uuid`() {
        assertEquals(
            "[helm plan 6f9619ff-8b86-d011-b42d-00c04fc964ff]",
            HelmReferences.plan(plan(humanId = null)),
        )
    }

    @Test
    fun `an artifact copies its id`() {
        assertEquals(
            "[helm artifact art-123]",
            HelmReferences.artifact(HelmArtifact(id = "art-123", title = "Report", kind = "md", versionCount = 1, createdAtEpochMs = 0, updatedAtEpochMs = 0)),
        )
    }

    @Test
    fun `a context copies its id`() {
        assertEquals(
            "[helm context ctx-9]",
            HelmReferences.context(HelmContext(id = "ctx-9", projectId = "p1", title = "Notes", type = "Testing", permission = ContextPermission.Readonly, content = "", x = null, y = null, createdAtEpochMs = 0, updatedAtEpochMs = 0)),
        )
    }

    private fun plan(humanId: String?) = HelmPlanSummary(
        id = "6f9619ff-8b86-d011-b42d-00c04fc964ff",
        humanId = humanId,
        title = "Ship the thing",
        type = "feature",
        status = PlanStatus.Ready,
        stateUpdatedAtEpochMs = null,
        sequenceId = null,
        blockedBy = emptyList(),
        blocks = emptyList(),
    )
}
