package io.github.wnijhof.tickory.store

import android.content.Context
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.GeoPolicy
import io.github.wnijhof.tickory.core.GeoState
import io.github.wnijhof.tickory.core.GeoStateCodec

/**
 * Wat de locatiecontrole op het toestel bewaart: of de gebruiker haar aan heeft gezet, wat we van de plaatsen weten (binnen
 * of buiten) en de laatste plaatsbepaling. Privé-opslag van de app, niet in back-ups en nooit naar de server.
 */
object GeoStore {
    private const val FILE = "tickory_geo"
    private const val KEY_STATE = "state"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_DECLINED = "declined"
    private const val KEY_MIN_TIME = "registered_min_time"
    private const val KEY_MIN_DISTANCE = "registered_min_distance"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun loadState(context: Context): GeoState = GeoStateCodec.decode(prefs(context).getString(KEY_STATE, null))

    fun saveState(context: Context, state: GeoState) {
        // commit en niet apply: een ontvanger kan meteen daarna worden stilgelegd
        prefs(context).edit(commit = true) { putString(KEY_STATE, GeoStateCodec.encode(state)) }
    }

    /** Heeft de gebruiker de locatiecontrole aangezet? Standaard uit: er wordt pas om locatie gevraagd na een eigen keuze. */
    fun enabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, value: Boolean) = prefs(context).edit(commit = true) { putBoolean(KEY_ENABLED, value) }

    /** De gebruiker heeft de toestemming geweigerd; de app vraagt het dan niet steeds opnieuw. */
    fun declined(context: Context): Boolean = prefs(context).getBoolean(KEY_DECLINED, false)

    fun setDeclined(context: Context, value: Boolean) = prefs(context).edit(commit = true) { putBoolean(KEY_DECLINED, value) }

    /** Met welke frequentie de updates nu bij Android zijn aangevraagd, of null als er niets is aangevraagd. */
    fun registeredCadence(context: Context): GeoPolicy.Cadence? {
        val p = prefs(context)
        if (!p.contains(KEY_MIN_TIME)) return null
        return GeoPolicy.Cadence(p.getLong(KEY_MIN_TIME, 0), p.getFloat(KEY_MIN_DISTANCE, 0f))
    }

    fun setRegisteredCadence(context: Context, cadence: GeoPolicy.Cadence?) = prefs(context).edit(commit = true) {
        if (cadence == null) {
            remove(KEY_MIN_TIME)
            remove(KEY_MIN_DISTANCE)
        } else {
            putLong(KEY_MIN_TIME, cadence.minTimeMs)
            putFloat(KEY_MIN_DISTANCE, cadence.minDistanceM)
        }
    }

    /** Afmelden of een andere server: alles wat bij de vorige gebruiker hoorde is weg. De keuze aan/uit blijft. */
    fun clearState(context: Context) = prefs(context).edit(commit = true) { remove(KEY_STATE) }
}
