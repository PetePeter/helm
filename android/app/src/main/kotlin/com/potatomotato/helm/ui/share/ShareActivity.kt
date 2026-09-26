package com.potatomotato.helm.ui.share

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.potatomotato.helm.ble.BlePermissions
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.ShareState
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.megabytes
import com.potatomotato.helm.data.shareRefusal
import com.potatomotato.helm.data.uploadSupport
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.save.AndroidAttachmentStaging
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmRow
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.components.StateDot
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmTheme

/**
 * The Android share-sheet target: one file from any app → pick a session → the
 * desktop saves it to its inbox and adds a DRAFT naming the path. Nothing is
 * sent to the CLI; the user sends the draft when ready (docs/mobile-app.md).
 *
 * Its own activity rather than a route in [com.potatomotato.helm.MainActivity]:
 * a share arrives on top of another app's task and should leave it there when
 * done, not drop the user into Helm's home.
 */
class ShareActivity : ComponentActivity() {
    private val staging by lazy { AndroidAttachmentStaging(this) }
    private var staged: StagedAttachment? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val source = sharedUri(intent)
        val mimeType = intent.type
        val client = HelmPairing.client
        // A cold start from the share sheet: the link service may not be up yet.
        if (BlePermissions.allGranted(this)) HelmLinkService.start(this)
        if (savedInstanceState == null) client.shares.reset()
        client.refreshSessions()
        client.refreshCapabilities()
        setContent {
            HelmTheme {
                ShareScreen(
                    client = client,
                    source = source,
                    stage = { uri -> staging.stage(uri, null, mimeType).also { staged = it } },
                    onClose = ::finish,
                )
            }
        }
    }

    override fun onDestroy() {
        // The cache copy is per-share, not a library: gone once the screen is.
        if (isFinishing) staged?.let(staging::discard)
        super.onDestroy()
    }

    private fun sharedUri(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        return uri?.toString()
    }
}

@Composable
private fun ShareScreen(
    client: HelmClient,
    source: String?,
    stage: suspend (String) -> StagedAttachment?,
    onClose: () -> Unit,
) {
    val sessions by client.sessions.sessions.collectAsState()
    val state by client.shares.state.collectAsState()
    val capabilities by client.capabilities.state.collectAsState()
    val linkState by HelmLink.state.collectAsState()
    var file by remember { mutableStateOf<StagedAttachment?>(null) }
    var unreadable by remember { mutableStateOf(source == null) }

    LaunchedEffect(source) {
        if (source != null) {
            file = stage(source)
            unreadable = file == null
        }
    }

    val pick: (HelmSession) -> Unit = { session ->
        file?.let { staged ->
            val support = uploadSupport(
                toolPermitted = (capabilities as? Capabilities.Known)?.let { METHOD_SHARE_ADD in it.tools },
                negotiatedProtocol = client.negotiatedProtocol(),
                linked = linkState == LinkState.Linked,
            )
            val refusal = shareRefusal(staged.sizeBytes, HelmLink.holderRank, support)
            if (refusal != null) client.shares.failed(refusal) else client.shareFile(session.id, session.name, staged)
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(vertical = HelmSpacing.Lg),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        Text(
            text = "Share to Helm",
            style = MaterialTheme.typography.titleLarge,
            color = HelmColors.Txt,
            modifier = Modifier.padding(horizontal = HelmSpacing.Gutter),
        )
        Text(
            text = when {
                unreadable -> "This file could not be read"
                file == null -> "Reading the file…"
                else -> "${file!!.filename} · ${megabytes(file!!.sizeBytes)}"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = HelmColors.Dim,
            modifier = Modifier.padding(horizontal = HelmSpacing.Gutter),
        )
        when (val current = state) {
            ShareState.Picking -> if (unreadable) {
                Footer { PrimaryButton(text = "Close", onClick = onClose) }
            } else {
                Text(
                    text = if (sessions.isEmpty()) "No sessions yet — is Helm connected?" else "Add it to which session's draft?",
                    style = MaterialTheme.typography.bodyMedium,
                    color = HelmColors.Dim,
                    modifier = Modifier.padding(horizontal = HelmSpacing.Gutter),
                )
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(sessions, key = { it.id }) { session ->
                        HelmRow(
                            title = session.name,
                            onClick = { pick(session) },
                            subtitle = {
                                Text(
                                    text = session.cliTypeName,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = HelmColors.Dim,
                                )
                            },
                            trailing = { StateDot(state = session.activity) },
                            chevron = false,
                        )
                    }
                }
            }
            is ShareState.Sending -> Column(
                modifier = Modifier.padding(horizontal = HelmSpacing.Gutter),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                LinearProgressIndicator(
                    progress = { if (current.total > 0) current.sent.toFloat() / current.total else 0f },
                    modifier = Modifier.fillMaxWidth(),
                    color = HelmColors.Accent,
                )
                Text(
                    text = "Sending ${megabytes(current.sent)} of ${megabytes(current.total)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = HelmColors.Dim,
                )
            }
            is ShareState.Done -> Footer {
                Text(text = current.message, style = MaterialTheme.typography.titleMedium, color = HelmColors.Txt)
                PrimaryButton(text = "Done", onClick = onClose)
            }
            is ShareState.Failed -> Footer {
                Text(text = current.message, style = MaterialTheme.typography.titleMedium, color = HelmColors.Txt)
                GhostButton(text = "Pick another session", onClick = client.shares::reset)
                PrimaryButton(text = "Close", onClick = onClose)
            }
        }
    }
}

@Composable
private fun Footer(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) { content() }
}

/** The tool the gate must have granted for a share to be offered. */
private const val METHOD_SHARE_ADD = "session_share_file_add"
