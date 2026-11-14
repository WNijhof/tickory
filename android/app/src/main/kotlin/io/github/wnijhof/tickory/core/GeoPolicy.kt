package io.github.wnijhof.tickory.core

import kotlin.math.max

/**
 * Hoe vaak de positie bekeken wordt, als zuivere regels. Het uitgangspunt is zuinigheid: ver van elke plaats is
 * zelden kijken genoeg, dichtbij vaker. Er is nooit een continue GPS; het toestel krijgt hooguit een verzoek om af en toe
 * een (netwerk)positie door te geven, en een eenmalige GPS-bepaling als we te lang niets hebben gehoord.
 */
object GeoPolicy {
    /** Hoe vaak, en na hoeveel meter bewegen, het toestel een positie mag doorgeven. */
    data class Cadence(val minTimeMs: Long, val minDistanceM: Float)

    /** Een voetganger of een auto in de stad: zo snel kan de rand dichterbij komen (meter per seconde). */
    const val ASSUMED_SPEED_MPS: Double = 20.0

    const val MIN_INTERVAL_MS: Long = 60_000
    const val MAX_INTERVAL_MS: Long = 20L * 60 * 1000
    const val MIN_DISTANCE_M: Double = 25.0
    const val MAX_DISTANCE_M: Double = 1500.0

    /** Het zekerheidsnet (WorkManager) kijkt zo vaak. Minder kan niet: 15 minuten is het minimum van Android. */
    const val SAFETY_NET_MINUTES: Long = 15

    /**
     * @param boundaryM de afstand tot de rand van de dichtstbijzijnde plaats ([Geofence.nearestBoundaryM]); null als er
     *   nog geen positie bekend is (dan kijken we gematigd vaak, tot we er een hebben)
     */
    fun cadence(boundaryM: Double?): Cadence {
        if (boundaryM == null) return Cadence(5L * 60 * 1000, 250f)
        val interval = (boundaryM / ASSUMED_SPEED_MPS * 1000).toLong().coerceIn(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
        val distance = (boundaryM / 4).coerceIn(MIN_DISTANCE_M, MAX_DISTANCE_M)
        return Cadence(roundTo(interval, 30_000), (roundTo(distance.toLong(), 25)).toFloat())
    }

    /**
     * Moet het zekerheidsnet zelf een positie vragen (met GPS), of is wat we al hebben nog goed genoeg? Hoe dichter bij een
     * rand, hoe jonger de laatste positie mag zijn.
     */
    fun needActiveFix(lastFixAgeMs: Long?, boundaryM: Double?): Boolean {
        if (lastFixAgeMs == null || boundaryM == null) return true
        val limit = when {
            boundaryM < 1_000 -> 15L * 60 * 1000
            boundaryM < 5_000 -> 30L * 60 * 1000
            else -> 90L * 60 * 1000
        }
        return lastFixAgeMs > limit
    }

    /** Heeft het nog zin om de registratie bij het toestel te vervangen? Niet bij een bijna gelijke aanvraag. */
    fun sameCadence(a: Cadence?, b: Cadence): Boolean =
        a != null && a.minTimeMs == b.minTimeMs && a.minDistanceM == b.minDistanceM

    private fun roundTo(value: Long, step: Long): Long = max(step, (value + step / 2) / step * step)
}
