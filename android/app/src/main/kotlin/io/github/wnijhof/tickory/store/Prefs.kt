package io.github.wnijhof.tickory.store

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.ServerAddress

/** De instellingen van de app: welke server, en de (versleutelde) aanmelding. Privé-opslag van de app, niet in back-ups. */
class Prefs(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("tickory", Context.MODE_PRIVATE)

    /** De oorsprong van de server, bijvoorbeeld "https://taken.voorbeeld.nl"; null zolang er nog niets is ingesteld. */
    val serverOrigin: String? get() = prefs.getString(KEY_ORIGIN, null)

    /** Ligt de server op het eigen netwerk? Dan is op Android 17 en nieuwer de toestemming "Apparaten in de buurt" nodig. */
    var serverIsLocal: Boolean
        get() = prefs.getBoolean(KEY_LOCAL, false)
        set(value) = prefs.edit { putBoolean(KEY_LOCAL, value) }

    /**
     * Staat er een onversleuteld (http) adres ingesteld naar een server buiten het eigen netwerk? Dat staat de app niet toe
     * (zie ServerAddress.cleartextAllowed); het kan alleen nog zo zijn bij een adres dat is ingesteld in een oudere versie.
     */
    val cleartextToInternet: Boolean
        get() {
            val address = serverOrigin?.let { ServerAddress.parse(it) } as? ServerAddress.Result.Ok ?: return false
            return !ServerAddress.cleartextAllowed(address, serverIsLocal)
        }

    /** De server gaf 401: niet meer verversen tot de web-app opnieuw een sessie doorgeeft. */
    var sessionExpired: Boolean
        get() = prefs.getBoolean(KEY_EXPIRED, false)
        set(value) = prefs.edit { putBoolean(KEY_EXPIRED, value) }

    /** Het sessietoken, versleuteld met een sleutel uit de Android Keystore (zie TokenVault). Nooit leesbare tekst. */
    var encryptedToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit { if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value) }

    fun setServer(origin: String, isLocal: Boolean) = prefs.edit {
        putString(KEY_ORIGIN, origin)
        putBoolean(KEY_LOCAL, isLocal)
    }

    fun clearServer() = prefs.edit {
        remove(KEY_ORIGIN)
        remove(KEY_LOCAL)
        remove(KEY_EXPIRED)
        remove(KEY_TOKEN)
    }

    private companion object {
        const val KEY_ORIGIN = "server_origin"
        const val KEY_LOCAL = "server_is_local"
        const val KEY_EXPIRED = "session_expired"
        const val KEY_TOKEN = "session_token_encrypted"
    }
}
