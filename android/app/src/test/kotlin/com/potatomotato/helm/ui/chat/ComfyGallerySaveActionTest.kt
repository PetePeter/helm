package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.data.PullState
import org.junit.Assert.assertEquals
import org.junit.Test

class ComfyGallerySaveActionTest {
    @Test
    fun idleAndFailedStatesOfferDownload() {
        assertEquals(ComfyGallerySaveAction.Download, comfyGallerySaveAction(PullState.Idle))
        assertEquals(ComfyGallerySaveAction.Download, comfyGallerySaveAction(PullState.Failed("network error")))
    }

    @Test
    fun pullingStateIsBusy() {
        assertEquals(ComfyGallerySaveAction.Busy, comfyGallerySaveAction(PullState.Pulling(25, 100)))
    }

    @Test
    fun previewOnlyReadyStateOffersSavingThatUri() {
        assertEquals(
            ComfyGallerySaveAction.SavePreview("temporary preview", "content://preview"),
            comfyGallerySaveAction(PullState.Ready("temporary preview", "content://preview", previewOnly = true)),
        )
    }

    @Test
    fun downloadedReadyStateOffersOpeningThatUri() {
        assertEquals(
            ComfyGallerySaveAction.Open("Downloads/image.png", "content://saved"),
            comfyGallerySaveAction(PullState.Ready("Downloads/image.png", "content://saved")),
        )
    }
}
