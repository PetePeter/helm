package com.potatomotato.helm.ui.components

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * A refused permission, explained — said the same way whichever permission it is.
 *
 * Two gates need this (Bluetooth at launch, the microphone at the mic button)
 * and a second, differently worded version would be the app contradicting
 * itself about how it asks for things.
 *
 * "Open settings" is always offered: once a permission is denied permanently the
 * system stops showing the prompt at all, and without this route the user is
 * stuck with a button that appears to do nothing.
 */
@Composable
fun PermissionRationale(
    title: String,
    body: String,
    onGrant: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
    ) {
        Text(
            text = title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            text = body,
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        // Primary action sits lowest and reads accent — one-handed reach.
        PrimaryButton(text = stringResource(R.string.permission_grant), onClick = onGrant)
        GhostButton(
            text = stringResource(R.string.permission_settings),
            onClick = {
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ),
                )
            },
        )
    }
}
