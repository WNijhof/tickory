package io.github.wnijhof.tickory.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** De talen van de app. Alles wat geen Engels is, krijgt Nederlands: dat is de standaardtaal. */
enum class Lang {
    NL, EN;

    companion object {
        fun of(code: String?): Lang = if (code != null && code.lowercase().startsWith("en")) EN else NL
    }
}

/**
 * De datum van een taak als korte tekst voor in een melding: "vandaag 14:00", "morgen", "wo 18 nov 09:30".
 * Eigen woordenlijsten in plaats van de taaltabellen van het toestel: die verschillen per Android-versie
 * ("nov." of "nov"), en zo is de uitkomst overal gelijk en op de pc te testen.
 */
object DueText {
    private val DAYS_NL = arrayOf("ma", "di", "wo", "do", "vr", "za", "zo")
    private val DAYS_EN = arrayOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
    private val MONTHS_NL = arrayOf("jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec")
    private val MONTHS_EN = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /**
     * @param due datum van de taak: "2026-11-13", "2026-11-13T14:00" of "2026-11-13T14:00:00"
     * @param use24Hour alleen voor Engels: 14:00 of 2:00 PM. Nederlands gebruikt altijd de 24-uursklok.
     * @return null als de taak geen (geldige) datum heeft
     */
    fun format(due: String?, nowMs: Long, zone: ZoneId, lang: Lang, use24Hour: Boolean = true): String? {
        val date = Planner.localDate(due) ?: return null
        val time = Planner.localDateTime(due)?.toLocalTime()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()

        val day = when (ChronoUnit.DAYS.between(today, date)) {
            0L -> if (lang == Lang.EN) "today" else "vandaag"
            1L -> if (lang == Lang.EN) "tomorrow" else "morgen"
            -1L -> if (lang == Lang.EN) "yesterday" else "gisteren"
            else -> dayMonth(date, today, lang)
        }
        if (time == null) return day

        return "$day ${clock(time, lang, use24Hour)}"
    }

    /** Een kloktijd: "14:00", of voor Engels zonder 24-uursklok "2:00 PM". */
    fun clock(time: java.time.LocalTime, lang: Lang, use24Hour: Boolean = true): String {
        val minute = time.minute.toString().padStart(2, '0')
        return if (lang == Lang.NL || use24Hour) {
            "${time.hour.toString().padStart(2, '0')}:$minute"
        } else {
            val hour12 = if (time.hour % 12 == 0) 12 else time.hour % 12
            "$hour12:$minute ${if (time.hour < 12) "AM" else "PM"}"
        }
    }

    /** "vr 13 nov" (met het jaar als het niet dit jaar is). */
    fun dayMonth(date: LocalDate, today: LocalDate, lang: Lang): String {
        val weekday = date.dayOfWeek.value - 1 // maandag = 0
        val month = date.monthValue - 1
        val base = if (lang == Lang.EN) {
            "${DAYS_EN[weekday]} ${date.dayOfMonth} ${MONTHS_EN[month]}"
        } else {
            "${DAYS_NL[weekday]} ${date.dayOfMonth} ${MONTHS_NL[month]}"
        }
        return if (date.year == today.year) base else "$base ${date.year}"
    }
}
