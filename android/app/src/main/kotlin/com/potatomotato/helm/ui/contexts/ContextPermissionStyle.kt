package com.potatomotato.helm.ui.contexts

import androidx.compose.ui.graphics.Color
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ContextPermission
import com.potatomotato.helm.ui.theme.HelmColors

/** What a node's write permission is called, kept out of the composables. */
internal val ContextPermission.labelRes: Int
    get() = when (this) {
        ContextPermission.Readonly -> R.string.context_permission_readonly
        ContextPermission.Writable -> R.string.context_permission_writable
    }

/**
 * The permission pill's colour.
 *
 * Writable is the one that carries INFORMATION — an agent can change this node
 * under you — so it gets the waiting blue; read-only is the quiet default and
 * gets [HelmColors.Dim]. Deliberately not the accent: the accent means "the
 * thing you came here to do", and this phase does not write.
 */
internal val ContextPermission.pillColor: Color
    get() = when (this) {
        ContextPermission.Readonly -> HelmColors.Dim
        ContextPermission.Writable -> HelmColors.State.Waiting
    }
