package io.github.wnijhof.tickory.core

/**
 * "Gebruik mijn huidige positie" in het scherm Plaatsen: de app bepaalt één keer de positie en geeft die als gebeurtenis
 * `tickory-position` aan de web-app (`client/core/places.js`). De WebView zelf heeft bewust geen locatie. Er gaan alleen
 * getallen en vaste foutcodes in het stukje JavaScript, nooit tekst van buiten.
 */
object PositionScript {
    const val EVENT = "tickory-position"
    private val ERRORS = setOf("denied", "unavailable", "timeout")

    /** De positie; onmogelijke coördinaten worden "unavailable". */
    fun result(lat: Double, lon: Double, accuracyM: Float?): String {
        if (!Geo.validCoordinates(lat, lon)) return error("unavailable")
        val accuracy = accuracyM?.takeIf { it.isFinite() && it >= 0f }?.let { ",accuracy:${it.toDouble()}" } ?: ""
        return dispatch("{lat:$lat,lon:$lon$accuracy}")
    }

    /** `denied` (geen toestemming), `unavailable` (geen positie te bepalen) of `timeout`. Al het andere wordt `unavailable`. */
    fun error(code: String): String = dispatch("{error:\"${if (code in ERRORS) code else "unavailable"}\"}")

    private fun dispatch(detail: String) = "window.dispatchEvent(new CustomEvent(\"$EVENT\",{detail:$detail}));"
}
