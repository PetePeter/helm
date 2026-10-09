package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.data.PullState

internal sealed interface ComfyGallerySaveAction {
    data object Busy : ComfyGallerySaveAction
    data object Download : ComfyGallerySaveAction
    data class SavePreview(val location: String, val uri: String) : ComfyGallerySaveAction
    data class Open(val location: String, val uri: String) : ComfyGallerySaveAction
}

internal fun comfyGallerySaveAction(state: PullState): ComfyGallerySaveAction = when (state) {
    PullState.Idle, is PullState.Failed -> ComfyGallerySaveAction.Download
    is PullState.Pulling -> ComfyGallerySaveAction.Busy
    is PullState.Ready -> if (state.previewOnly) {
        ComfyGallerySaveAction.SavePreview(state.location, state.uri)
    } else {
        ComfyGallerySaveAction.Open(state.location, state.uri)
    }
}
