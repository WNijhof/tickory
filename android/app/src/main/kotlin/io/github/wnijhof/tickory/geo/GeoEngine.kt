package io.github.wnijhof.tickory.geo

import android.content.Context
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.core.Geo
import io.github.wnijhof.tickory.core.GeoEvent
import io.github.wnijhof.tickory.core.GeoPolicy
import io.github.wnijhof.tickory.core.GeoReminders
import io.github.wnijhof.tickory.core.GeoState
import io.github.wnijhof.tickory.core.Geofence
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.store.GeoStore
import io.github.wnijhof.tickory.store.ReminderStore

/**
 * Voert de locatiecontrole uit: ontvangt plaatsbepalingen, laat de regels ([Geofence]) beslissen, toont de meldingen en
 * houdt de aanvragen bij Android passend bij hoe dicht je bij een plaats bent. Alles loopt door één slot, zodat
 * een ontvanger, het zekerheidsnet en een tik op "Controleer nu" elkaar niet in de weg zitten.
 *
 * Privacy: de positie wordt hier alleen vergeleken met de plaatsen die de server bewaart. Er gaat niets naar buiten.
 */
object GeoEngine {
    private val lock = Any()

    /** Hoe de plaatsbepalingen worden opgehaald; in tests te vervangen. */
    @Volatile
    var sourceFactory: (Context) -> LocationSource = { PlatformLocationSource(it) }

    /** Zo lang wachten we op een eenmalige bepaling (GPS kan na een koude start een halve minuut kosten). */
    const val ACTIVE_FIX_TIMEOUT_MS = 25_000L

    /** Moet er nu op de achtergrond op plaatsen gelet worden? Aangezet, toegestaan, locatie aan, en minstens één open herinnering op een plek. */
    fun wanted(context: Context): Boolean {
        val app = context.applicationContext
        return GeoStore.enabled(app) && GeoPermissions.precise(app) && GeoPermissions.servicesOn(app) &&
            GeoReminders.watchedPlaces(ReminderStore.load(app).snapshot).isNotEmpty()
    }

    private fun canCheck(app: Context): Boolean = GeoStore.enabled(app) && GeoPermissions.precise(app) && GeoPermissions.servicesOn(app)

    /**
     * Zet alles goed na een verandering: nieuwe gegevens van de server, opstarten, een andere toestemming of een andere
     * keuze van de gebruiker. Staat er niets te doen, dan wordt alles gestopt; anders loopt de aanvraag bij Android en het
     * zekerheidsnet, en leggen we direct vast waar je nu bent (zodat een nieuwe herinnering niet afgaat voor een plek
     * waar je al bent). Kan tot een halve minuut duren: niet op de hoofddraad aanroepen.
     */
    fun refresh(context: Context, check: Boolean = true) {
        val app = context.applicationContext
        val wantedNow: Boolean
        synchronized(lock) {
            val watched = GeoReminders.watchedPlaces(ReminderStore.load(app).snapshot)
            val state = GeoStore.loadState(app)
            val pruned = state.copy(tracks = state.tracks.filterKeys { id -> watched.any { it.id == id } })
            if (pruned != state) GeoStore.saveState(app, pruned)
            wantedNow = wanted(app)
            if (!wantedNow) {
                GeoRegistrar.unregister(app)
                GeoStore.setRegisteredCadence(app, null)
                GeoScheduler.cancel(app)
            } else {
                GeoScheduler.ensure(app)
                adaptCadence(app, pruned, watched)
            }
        }
        if (wantedNow && check) tick(app)
    }

    /**
     * Kijkt nu: verwerkt wat Android als laatste weet en vraagt zo nodig zelf één verse bepaling (GPS). Dit is het werk van
     * het zekerheidsnet, van "Controleer nu" (met [forceActive]) en van [refresh].
     */
    fun tick(context: Context, forceActive: Boolean = false) {
        val app = context.applicationContext
        // "Controleer nu" werkt ook zonder herinnering op een plek, om te kunnen zien of de controle werkt
        if (!(if (forceActive) canCheck(app) else wanted(app))) return
        val source = sourceFactory(app)
        val fixes = ArrayList<Fix>(source.lastKnown())
        val needActive: Boolean
        synchronized(lock) {
            val watched = GeoReminders.watchedPlaces(ReminderStore.load(app).snapshot)
            val state = GeoStore.loadState(app)
            val now = AppClock.now()
            // de beste wat we al hebben: de nieuwste van wat Android weet en wat we zelf onthouden hebben
            val newest = (fixes + listOfNotNull(state.lastFix)).maxByOrNull { it.atMs }
            val age = newest?.let { now - it.atMs }
            val boundary = newest?.let { Geofence.nearestBoundaryM(it, watched) }
            needActive = forceActive || GeoPolicy.needActiveFix(age, boundary)
        }
        if (needActive) source.current(ACTIVE_FIX_TIMEOUT_MS)?.let { fixes.add(it) }
        onFixes(app, fixes)
    }

    /**
     * Verwerkt plaatsbepalingen (uit de ontvanger, uit [tick]). Meldt aankomst en vertrek bij de herinneringen die daarop
     * wachten, één keer per aankomst of vertrek, en slaat de toestand op.
     */
    fun onFixes(context: Context, fixes: List<Fix>) {
        val app = context.applicationContext
        synchronized(lock) {
            if (!GeoStore.enabled(app)) return
            val snapshot = ReminderStore.load(app).snapshot
            val watched = GeoReminders.watchedPlaces(snapshot)
            val now = AppClock.now()
            var state = GeoStore.loadState(app)
            val events = ArrayList<GeoEvent>()
            for (fix in fixes.sortedBy { it.atMs }) {
                val outcome = Geofence.evaluate(state, fix, watched, now)
                state = outcome.state
                events.addAll(outcome.events)
            }
            if (fixes.isEmpty()) state = state.copy(lastCheckMs = now)
            // Eerst tonen, dan vastleggen: valt het proces ertussen weg, dan komt de melding hooguit nog een keer (op dezelfde plek
            // in de lijst, want hetzelfde label); andersom zou de aankomst voorgoed verloren zijn.
            for (planned in GeoReminders.due(events, snapshot)) Notifications.show(app, planned)
            GeoStore.saveState(app, state)
            if (wanted(app)) adaptCadence(app, state, watched)
        }
    }

    /** Past de aanvraag bij Android aan op de afstand tot de dichtstbijzijnde rand, maar alleen als dat echt verschilt. */
    private fun adaptCadence(app: Context, state: GeoState, watched: List<io.github.wnijhof.tickory.core.PlaceInfo>) {
        val boundary = state.lastFix?.let { Geofence.nearestBoundaryM(it, watched) }
        val cadence = GeoPolicy.cadence(boundary)
        if (GeoPolicy.sameCadence(GeoStore.registeredCadence(app), cadence)) return
        if (GeoRegistrar.register(app, cadence)) GeoStore.setRegisteredCadence(app, cadence)
    }

    /** De gebruiker zet de locatiecontrole aan of uit. Uit stopt alles direct en wist wat we over de plaatsen wisten. */
    fun setEnabled(context: Context, enabled: Boolean) {
        val app = context.applicationContext
        GeoStore.setEnabled(app, enabled)
        if (enabled) GeoStore.setDeclined(app, false)
        else synchronized(lock) {
            GeoRegistrar.unregister(app)
            GeoStore.setRegisteredCadence(app, null)
            GeoScheduler.cancel(app)
            GeoStore.clearState(app)
        }
    }

    /** Afmelden of een andere server: de plaatsen van de vorige gebruiker zijn niet meer van toepassing. */
    fun clear(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            GeoRegistrar.unregister(app)
            GeoStore.setRegisteredCadence(app, null)
            GeoScheduler.cancel(app)
            GeoStore.clearState(app)
        }
    }

    /** Wat de web-app in "Plaatsen" toont. Bevat afstanden tot plaatsen, nooit coördinaten van de gebruiker. */
    fun status(context: Context): Map<String, Any?> {
        val app = context.applicationContext
        val snapshot = ReminderStore.load(app).snapshot
        val watched = GeoReminders.watchedPlaces(snapshot)
        val state = GeoStore.loadState(app)
        val fix = state.lastFix
        val enabled = GeoStore.enabled(app)
        return mapOf(
            "enabled" to enabled,
            "precise" to GeoPermissions.precise(app),
            "approximate" to GeoPermissions.approximateOnly(app),
            "background" to GeoPermissions.background(app),
            "servicesOn" to GeoPermissions.servicesOn(app),
            "hasGps" to GeoPermissions.hasGps(app),
            "needed" to watched.isNotEmpty(),
            "running" to (enabled && GeoStore.registeredCadence(app) != null),
            "declined" to GeoStore.declined(app),
            "lastCheckAt" to state.lastCheckMs,
            "lastFixAt" to (fix?.atMs ?: 0L),
            "accuracy" to fix?.accuracyM?.toDouble(),
            "ignored" to state.lastIgnored?.name?.lowercase(),
            "places" to snapshot.places.filter { !it.deleted }.map { place ->
                mapOf(
                    "id" to place.id,
                    "name" to place.name,
                    "distance" to fix?.let { Math.round(Geo.distanceMeters(it, place)) },
                    "inside" to state.tracks[place.id]?.inside,
                )
            },
        )
    }
}
