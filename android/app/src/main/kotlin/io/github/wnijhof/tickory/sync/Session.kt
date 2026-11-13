package io.github.wnijhof.tickory.sync

import android.content.Context
import io.github.wnijhof.tickory.BuildConfig
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.widget.WidgetUpdater

/** De aanmelding zoals de web-app die doorgeeft. Het token is voor de app ondoorzichtige tekst. */
object Session {
    /** Wat de app meestuurt als User-Agent bij zijn eigen verzoeken: alleen de naam en de versie van de app. */
    val userAgent: String = "Tickory-Android/${BuildConfig.VERSION_NAME}"

    /** Is er een server ingesteld en een sessie die (voor zover we weten) nog geldig is? */
    fun isActive(context: Context): Boolean {
        val prefs = Prefs(context)
        return prefs.serverOrigin != null && prefs.encryptedToken != null && !prefs.sessionExpired
    }

    /**
     * De web-app geeft het sessietoken door, of "" bij afmelden.
     *
     * Een ander token dan we hadden kan een andere gebruiker zijn: dan gaan eerst de oude alarmen en meldingen weg, en
     * komt het nieuwe plan uit de eerstvolgende verversing (die meteen start).
     */
    @Synchronized
    fun set(context: Context, token: String) {
        val app = context.applicationContext
        if (token.isEmpty()) {
            signOut(app)
            return
        }
        if (!isUsable(token)) return
        val prefs = Prefs(app)
        val current = TokenVault.load(app)
        if (current == token && !prefs.sessionExpired) {
            SyncScheduler.start(app) // dezelfde sessie: alleen zorgen dat het verversen loopt
            return
        }
        if (current != token) {
            ReminderEngine.clear(app, keepShown = true)
            // Een ander token kan een andere gebruiker zijn: de widgets tonen niets tot de eerste verversing laat zien van wie de gegevens zijn.
            WidgetStore.markUnverified(app)
        }
        if (!TokenVault.save(app, token)) return
        prefs.sessionExpired = false
        SyncScheduler.start(app)
        WidgetUpdater.updateAll(app)
    }

    /** Afmelden: token weg, achtergrondwerk gestopt, alle alarmen en meldingen weg. */
    @Synchronized
    fun signOut(context: Context) {
        val app = context.applicationContext
        SyncScheduler.stop(app)
        TokenVault.clear(app)
        Prefs(app).sessionExpired = false
        ReminderEngine.clear(app, keepShown = false)
        WidgetStore.clearAll(app) // taken, projecten en de wachtrij van deze gebruiker: weg
        WidgetUpdater.updateAll(app)
    }

    /** De server zei 401: stoppen met verversen. De alarmen die er staan, blijven staan. */
    fun markExpired(context: Context) {
        val app = context.applicationContext
        Prefs(app).sessionExpired = true
        SyncScheduler.stop(app)
        WidgetUpdater.updateAll(app) // de widgets vragen om opnieuw in te loggen
    }

    /**
     * Een token gaat in een HTTP-header mee. Alles wat daar niet in kan (spaties, regeleinden, tekens buiten ASCII) of
     * onzinnig lang is, negeren we. Verder nemen we niets aan over de vorm.
     */
    private fun isUsable(token: String): Boolean = token.length <= 4096 && token.all { it.code in 0x21..0x7e }
}
