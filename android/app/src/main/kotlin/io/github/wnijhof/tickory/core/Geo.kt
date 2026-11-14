package io.github.wnijhof.tickory.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Een plaats van de gebruiker, zoals de server die bewaart (privé per gebruiker). [radiusM] in meters.
 * De server kent alleen de plaats; de positie van de gebruiker komt er nooit.
 */
data class PlaceInfo(
    val id: String,
    val name: String,
    val lat: Double,
    val lon: Double,
    val radiusM: Int,
    val deleted: Boolean = false,
) {
    /** Verandert dit, dan is wat we over "binnen of buiten" wisten niet meer geldig (bij een verzette of verruimde plaats). */
    val signature: String get() = "$lat|$lon|$radiusM"
}

/**
 * Eén plaatsbepaling van het toestel. [accuracyM] is de straal (meters) waarbinnen het toestel zegt te zitten (68%), of null
 * als het toestel dat niet meldt. [atMs] is het tijdstip van de bepaling (milliseconden sinds 1970).
 */
data class Fix(val lat: Double, val lon: Double, val accuracyM: Float?, val atMs: Long)

/** Afstanden op aarde, op het toestel zelf berekend (haversine). Dezelfde formule staat in shared/places.js voor de web-app. */
object Geo {
    const val EARTH_RADIUS_M: Double = 6_371_008.8

    fun validCoordinates(lat: Double, lon: Double): Boolean =
        lat.isFinite() && lon.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0

    /**
     * De afstand over het aardoppervlak in meters. Klopt ook vlak bij de polen en over de datumgrens, omdat alleen
     * sinussen van verschillen in lengte en breedte worden gebruikt (nooit een rechtstreeks verschil in lengte van 359 graden).
     */
    fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2) * sin(dLat / 2) + cos(p1) * cos(p2) * sin(dLon / 2) * sin(dLon / 2)
        // door afrondingsfouten kan `a` net boven 1 uitkomen (tegenpolen): dan geeft asin geen getal
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
    }

    fun distanceMeters(fix: Fix, place: PlaceInfo): Double = distanceMeters(fix.lat, fix.lon, place.lat, place.lon)
}
