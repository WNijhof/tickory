package io.github.wnijhof.tickory.geo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat

/** Wat Android het toestel toestaat voor locatie, op één plek. */
object GeoPermissions {
    private fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Nauwkeurige locatie (GPS). Alleen dit is nauwkeurig genoeg voor een straal van enkele honderden meters. */
    fun precise(context: Context): Boolean = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    /** Alleen een grove locatie (ongeveer een kilometer): te onnauwkeurig voor een plaats. */
    fun approximateOnly(context: Context): Boolean = !precise(context) && granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** "Altijd toestaan": ook als de app dicht is. Voor Android 10 bestaat dit onderscheid niet; nauwkeurige locatie is dan genoeg. */
    fun background(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    /** Staat locatie aan in de instellingen van het toestel? */
    fun servicesOn(context: Context): Boolean {
        val manager = context.getSystemService(LocationManager::class.java) ?: return false
        return LocationManagerCompat.isLocationEnabled(manager)
    }

    /** Heeft dit toestel GPS? Zonder, dan is alleen een grove positie via netwerken mogelijk. */
    fun hasGps(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS)

    /** Mag de controle op de achtergrond draaien? */
    fun canWatchInBackground(context: Context): Boolean = precise(context) && background(context) && servicesOn(context)
}
