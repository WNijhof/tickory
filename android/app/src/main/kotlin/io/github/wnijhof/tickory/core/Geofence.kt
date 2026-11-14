package io.github.wnijhof.tickory.core

import kotlin.math.abs
import kotlin.math.max

enum class GeoKind { ENTER, LEAVE }

/** Iemand is een plaats binnengekomen of weggegaan. [atMs] is het tijdstip van de plaatsbepaling die dat liet zien. */
data class GeoEvent(val placeId: String, val kind: GeoKind, val atMs: Long, val distanceM: Double)

/**
 * Wat we van één plaats weten: zijn we er binnen, sinds wanneer we dat weten, en wanneer er voor het laatst een melding
 * voor was. [signature] hoort bij de plaats zoals ze toen was ([PlaceInfo.signature]).
 */
data class PlaceTrack(val inside: Boolean, val checkedMs: Long, val lastEventMs: Long?, val signature: String)

/**
 * Alles wat de locatiecontrole onthoudt. Onveranderlijk. Staat op het toestel, wordt nooit verstuurd.
 *
 * @property tracks per plaats: binnen of buiten. Een plaats zonder regel is "nog niet bekend".
 * @property lastFix de laatste plaatsbepaling die we gebruikt hebben
 * @property lastCheckMs wanneer we voor het laatst iets hebben bekeken (ook als het niets opleverde)
 * @property lastIgnored waarom de laatste plaatsbepaling niet is gebruikt, voor de statusweergave
 */
data class GeoState(
    val tracks: Map<String, PlaceTrack> = emptyMap(),
    val lastFix: Fix? = null,
    val lastCheckMs: Long = 0,
    val lastIgnored: Ignored? = null,
)

enum class Ignored { INVALID, FUTURE, STALE, OLD, INACCURATE, JUMP }

data class GeoOutcome(val state: GeoState, val events: List<GeoEvent>, val ignored: Ignored? = null)

/**
 * De regels voor "ben ik binnen of buiten een plaats?", als zuivere functie: geen Android, geen klok, geen opslag.
 *
 * Het doel is dat er per binnenkomst en per vertrek één melding komt, ook als de plaatsbepaling ruis heeft:
 *
 *  - **Hysterese.** Binnenkomen telt zodra de afstand tot het midden hooguit de straal is; weggaan pas als je, na aftrek
 *    van de onzekerheid van de bepaling, nog een marge ([margin]) buiten de straal zit. Tussen die twee ligt een band
 *    waarin niets verandert: GPS-ruis rond de rand geeft zo één melding en geen reeks. Een onzekere bepaling maakt het
 *    weggaan moeilijker, niet makkelijker.
 *  - **Nauwkeurigheid.** Een bepaling die onnauwkeuriger is dan de plaats groot is, kan niet "binnen" bewijzen en wordt
 *    daarvoor niet gebruikt; een bepaling slechter dan [MAX_ACCURACY_M] telt helemaal niet.
 *  - **Sprongen.** Een bepaling die in korte tijd ver weg zit (sneller dan een straaljager), is een foutieve meting en wordt overgeslagen.
 *  - **Eerste keer.** Van een plaats waarvan we nog niets weten, leggen we alleen vast of je er binnen bent, zonder melding:
 *    een herinnering "bij aankomst" die je maakt terwijl je al thuis bent, gaat niet meteen af.
 *  - **Verouderd.** Weten we al meer dan [STALE_MS] niets van een plaats (toestel uit, locatie uit), dan is een verandering
 *    van sindsdien geen nieuws meer: opnieuw leggen we alleen vast waar je nu bent.
 *  - **Snel heen en weer.** Na een melding voor een plaats volgt de tegenovergestelde pas na [MIN_FLIP_MS].
 *  - **Tijd.** Een bepaling uit de toekomst, een oude of een die niet nieuwer is dan de laatste, telt niet. Staat de klok
 *    van het toestel terug gezet, dan vergeten we de laatste bepaling in plaats van alles te negeren.
 */
object Geofence {
    /** Slechter dan dit (meters) gebruiken we niet. */
    const val MAX_ACCURACY_M: Float = 250f

    /** Zonder opgave nemen we een gemiddelde nauwkeurigheid aan. */
    const val DEFAULT_ACCURACY_M: Float = 100f

    /** Om "binnen" te kunnen vaststellen mag de onzekerheid niet groter zijn dan de straal, maar ook niet kleiner dan dit. */
    const val MIN_USABLE_ACCURACY_M: Float = 100f

    /** Een bepaling mag hooguit zo oud zijn (bijvoorbeeld een "laatst bekende positie"). */
    const val MAX_FIX_AGE_MS: Long = 10L * 60 * 1000

    /** Een klok die iets voorloopt is geen reden om een bepaling weg te gooien. */
    const val FUTURE_TOLERANCE_MS: Long = 2L * 60 * 1000

    const val MIN_FLIP_MS: Long = 2L * 60 * 1000
    const val STALE_MS: Long = 12L * 60 * 60 * 1000

    /** Sneller dan dit (meter per seconde, 504 km/u) beweegt niets dat een telefoon draagt; zo'n sprong is een meetfout. */
    const val MAX_SPEED_MPS: Double = 140.0

    /** Een sprong telt pas als hij groter is dan de onzekerheid van beide bepalingen plus dit. */
    const val JUMP_SLACK_M: Double = 200.0

    /** De marge buiten de straal waar je overheen moet voor "vertrokken". */
    fun margin(radiusM: Int): Double = max(50.0, radiusM * 0.25)

    /** Kan een bepaling met deze onzekerheid zeggen dat je binnen een plaats met deze straal bent? */
    fun usableForInside(accuracyM: Float, radiusM: Int): Boolean = accuracyM <= max(MIN_USABLE_ACCURACY_M, radiusM.toFloat())

    fun evaluate(state: GeoState, fix: Fix, places: List<PlaceInfo>, nowMs: Long): GeoOutcome {
        val live = places.filter { !it.deleted }
        val pruned = state.copy(tracks = state.tracks.filterKeys { id -> live.any { it.id == id } })

        fun skip(reason: Ignored) = GeoOutcome(pruned.copy(lastCheckMs = nowMs, lastIgnored = reason), emptyList(), reason)

        if (!Geo.validCoordinates(fix.lat, fix.lon)) return skip(Ignored.INVALID)
        if (fix.atMs > nowMs + FUTURE_TOLERANCE_MS) return skip(Ignored.FUTURE)
        if (fix.atMs < nowMs - MAX_FIX_AGE_MS) return skip(Ignored.STALE)

        // Een laatste bepaling "uit de toekomst" betekent dat de klok is teruggezet: vergeet haar.
        val last = pruned.lastFix?.takeIf { it.atMs <= nowMs + FUTURE_TOLERANCE_MS }
        if (last != null && fix.atMs <= last.atMs) return skip(Ignored.OLD)

        val accuracy = fix.accuracyM?.takeIf { it.isFinite() && it >= 0f } ?: DEFAULT_ACCURACY_M
        if (accuracy > MAX_ACCURACY_M) return skip(Ignored.INACCURATE)

        if (last != null) {
            val seconds = max(1.0, (fix.atMs - last.atMs) / 1000.0)
            val moved = Geo.distanceMeters(last.lat, last.lon, fix.lat, fix.lon)
            val lastAccuracy = last.accuracyM?.takeIf { it.isFinite() && it >= 0f } ?: DEFAULT_ACCURACY_M
            if (moved > accuracy + lastAccuracy + JUMP_SLACK_M && moved / seconds > MAX_SPEED_MPS) return skip(Ignored.JUMP)
        }

        val events = ArrayList<GeoEvent>()
        val tracks = HashMap(pruned.tracks)
        for (place in live) {
            val distance = Geo.distanceMeters(fix, place)
            val known = tracks[place.id]?.takeIf { it.signature == place.signature && fix.atMs - it.checkedMs <= STALE_MS }
            val usable = usableForInside(accuracy, place.radiusM)
            if (known == null) {
                // eerste keer (of verouderd): alleen vastleggen, zonder melding
                if (usable || distance - accuracy > place.radiusM) {
                    tracks[place.id] = PlaceTrack(distance <= place.radiusM && usable, fix.atMs, null, place.signature)
                } else {
                    tracks.remove(place.id)
                }
                continue
            }
            val recentlyFlipped = known.lastEventMs != null && fix.atMs - known.lastEventMs < MIN_FLIP_MS
            var track = known.copy(checkedMs = fix.atMs)
            if (!known.inside) {
                if (usable && distance <= place.radiusM && !recentlyFlipped) {
                    events.add(GeoEvent(place.id, GeoKind.ENTER, fix.atMs, distance))
                    track = track.copy(inside = true, lastEventMs = fix.atMs)
                }
            } else if (distance - accuracy >= place.radiusM + margin(place.radiusM) && !recentlyFlipped) {
                events.add(GeoEvent(place.id, GeoKind.LEAVE, fix.atMs, distance))
                track = track.copy(inside = false, lastEventMs = fix.atMs)
            }
            tracks[place.id] = track
        }
        val next = GeoState(tracks = tracks, lastFix = fix.copy(accuracyM = accuracy), lastCheckMs = nowMs, lastIgnored = null)
        return GeoOutcome(next, events)
    }

    /** Het getal waar [GeoPolicy] mee rekent: hoe ver de rand van de dichtstbijzijnde plaats nog weg is (0 als je erop staat). */
    fun nearestBoundaryM(fix: Fix, places: List<PlaceInfo>): Double? =
        places.filter { !it.deleted }.minOfOrNull { abs(Geo.distanceMeters(fix, it) - it.radiusM) }
}
