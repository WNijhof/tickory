package io.github.wnijhof.tickory

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.quickadd.QuickAddActivity

/**
 * De tegel "Taak toevoegen" in de snelle instellingen (het scherm dat je naar beneden trekt): één tik opent het kleine venster
 * Taak toevoegen (QuickAddActivity) over wat er op het scherm staat, ook vanaf het vergrendelscherm (na ontgrendelen). De tegel
 * zelf kent geen gegevens en vraagt geen toestemmingen; een taak komt er pas als de gebruiker Toevoegen kiest.
 */
class AddTaskTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.let {
            it.state = Tile.STATE_INACTIVE // een knop, geen schakelaar: nooit "aan"
            it.updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { open() } else open()
    }

    // Vanaf Android 14 moet het met een PendingIntent; de Intent-variant is er alleen voor Android 8 tot en met 13 (minSdk 26).
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun open() {
        val intent = launchIntent(this)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    companion object {
        /** De intentie van de tegel: het kleine venster "Taak toevoegen" (in het laatst gekozen project), expliciet, als eigen taak. */
        fun launchIntent(context: Context): Intent =
            Intent(context, QuickAddActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(DeepLink.EXTRA_ADD, "")
    }
}
