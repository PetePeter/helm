package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.ui.components.DetailLabel
import com.potatomotato.helm.ui.components.DetailValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the plan detail LEAVES OUT, which is the part with decisions in it.
 *
 * A plan mid-flight has no completion notes and an older plan has no
 * `autoImplement` answer at all; rendering every field unconditionally buries
 * the one or two that carry something under a column of empty labels.
 */
class PlanFieldsTest {

    private fun plan(
        humanId: String? = "P-0042",
        description: String = "Do the thing",
        stateInfo: String? = null,
        completionNotes: String? = null,
        type: String? = null,
        autoImplement: Boolean? = null,
        completionRecap: Boolean? = null,
        dirPath: String = "X:/work/alpha",
    ) = HelmPlan(
        id = "uuid",
        humanId = humanId,
        projectId = "proj",
        dirPath = dirPath,
        title = "A plan",
        description = description,
        status = PlanStatus.Coding,
        stateInfo = stateInfo,
        completionNotes = completionNotes,
        type = type,
        autoImplement = autoImplement,
        completionRecap = completionRecap,
        sequenceId = null,
        sessionId = null,
        createdAtEpochMs = 0L,
        stateUpdatedAtEpochMs = null,
        updatedAtEpochMs = 0L,
    )

    private fun labels(plan: HelmPlan) = PlanFields.of(plan).map { it.label }

    @Test
    fun `a bare plan shows only what it actually has`() {
        assertEquals(
            listOf(DetailLabel.PlanId, DetailLabel.Description, DetailLabel.Directory),
            labels(plan()),
        )
    }

    @Test
    fun `a plan with no human id yet does not get an empty one`() {
        assertEquals(
            listOf(DetailLabel.Description, DetailLabel.Directory),
            labels(plan(humanId = null)),
        )
    }

    @Test
    fun `blank prose counts as absent, not as an empty field`() {
        assertEquals(
            listOf(DetailLabel.PlanId, DetailLabel.Directory),
            labels(plan(description = "   ", stateInfo = "", completionNotes = "\n")),
        )
    }

    @Test
    fun `the state note is read before the completion prose`() {
        assertEquals(
            listOf(
                DetailLabel.PlanId,
                DetailLabel.Description,
                DetailLabel.StateNote,
                DetailLabel.CompletionNotes,
                DetailLabel.Directory,
            ),
            labels(plan(stateInfo = "waiting on review", completionNotes = "shipped")),
        )
    }

    @Test
    fun `a flag the desktop never answered is omitted, and false is not absent`() {
        assertEquals(
            listOf(DetailLabel.PlanId, DetailLabel.Description, DetailLabel.Directory),
            labels(plan(autoImplement = null, completionRecap = null)),
        )

        val answered = PlanFields.of(plan(autoImplement = false, completionRecap = true))
        assertEquals(
            listOf(DetailValue.Flag(false), DetailValue.Flag(true)),
            answered.filter { it.value is DetailValue.Flag }.map { it.value },
        )
    }

    @Test
    fun `prose is trimmed, because the wire carries the author's stray newlines`() {
        val field = PlanFields.of(plan(description = "  Do the thing\n")).first { it.label == DetailLabel.Description }

        assertEquals(DetailValue.Text("Do the thing"), field.value)
    }

    @Test
    fun `a plan with no directory on the wire does not claim one`() {
        assertEquals(
            listOf(DetailLabel.PlanId, DetailLabel.Description),
            labels(plan(dirPath = "")),
        )
    }
}
