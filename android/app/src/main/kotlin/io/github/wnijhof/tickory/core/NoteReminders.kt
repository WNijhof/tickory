package io.github.wnijhof.tickory.core

import java.time.LocalDateTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * Herinneringen op notities (zie SPEC 5k en shared/notes.js op de server): één tijdstip per notitie (`remind_at`, zwevend, in de
 * tijdzone van het toestel), eenmalig of herhaald (`remind_repeat`: daily, weekly, monthly, yearly). Een maandelijkse herhaling op
 * de 31e valt in een kortere maand op de laatste dag, een jaarlijkse op 29 februari in een gewoon jaar op 28 februari: precies zoals
 * de server rekent.
 *
 * De app plant ze als gewone herinneringen: een "taak" met id `note_<notitie-id>` (zonder datum) en per keer een herinnering van het
 * type "absolute". Voor een herhaling worden de komende keren vooruit gepland; na een verversing komen er weer nieuwe bij.
 */
object NoteReminders {
    const val PREFIX = "note_"

    /** Zoveel keren per notitie vooruit plannen, en niet verder dan zoveel dagen. */
    const val MAX_AHEAD = 10
    const val DAYS_AHEAD = 60L

    private val REPEATS = setOf("daily", "weekly", "monthly", "yearly")
    private val FLOATING: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm")
    private val SHAPE = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$")

    fun isNote(taskId: String?): Boolean = taskId != null && taskId.startsWith(PREFIX)

    fun noteId(taskId: String): String = taskId.removePrefix(PREFIX)

    fun taskIdFor(noteId: String): String = PREFIX + noteId

    /**
     * Per keer een vaste id met het tijdstip erin (note_<id>_202611160900): dezelfde keer heet na elke verversing hetzelfde, zodat
     * een melding die al getoond is niet terugkomt. Met een notitie-id van 40 tekens blijft dat binnen de 64 van [Ids.isSafeId].
     */
    fun reminderIdFor(noteId: String, floating: String): String = PREFIX + noteId + "_" + floating.filter(Char::isDigit)

    fun parse(floating: String?): LocalDateTime? {
        if (floating == null || !SHAPE.matches(floating)) return null
        return try {
            // strikt: 30 februari bestaat niet (de standaard zou er 28 of 29 februari van maken)
            val parsed = LocalDateTime.parse(floating, FLOATING)
            if (parsed.format(FLOATING) == floating) parsed else null
        } catch (_: DateTimeParseException) {
            null
        }
    }

    fun format(at: LocalDateTime): String = at.format(FLOATING)

    /** De `n`-de keer na [base] (n = 0 is [base] zelf). */
    fun at(base: LocalDateTime, repeat: String?, n: Long): LocalDateTime = when (repeat) {
        "daily" -> base.plusDays(n)
        "weekly" -> base.plusWeeks(n)
        "monthly", "yearly" -> {
            val months = if (repeat == "yearly") n * 12 else n
            val month = YearMonth.from(base).plusMonths(months)
            base.withDayOfMonth(1).withYear(month.year).withMonth(month.monthValue).withDayOfMonth(minOf(base.dayOfMonth, month.lengthOfMonth()))
        }
        else -> base
    }

    /**
     * De keren vanaf [from] (inclusief) tot [from] + [DAYS_AHEAD] dagen, hooguit [MAX_AHEAD]. Een eenmalige herinnering die voorbij
     * is, of een kapotte waarde, geeft niets.
     */
    fun upcoming(remindAt: String?, repeat: String?, from: LocalDateTime): List<LocalDateTime> {
        val base = parse(remindAt) ?: return emptyList()
        val until = from.plusDays(DAYS_AHEAD)
        if (repeat == null || repeat !in REPEATS) return if (!base.isBefore(from) && !base.isAfter(until)) listOf(base) else emptyList()
        // eerst een schatting van het aantal perioden tot [from], dan precies
        val estimate = when (repeat) {
            "daily" -> java.time.temporal.ChronoUnit.DAYS.between(base, from) - 1
            "weekly" -> java.time.temporal.ChronoUnit.WEEKS.between(base, from) - 1
            "monthly" -> java.time.temporal.ChronoUnit.MONTHS.between(base, from) - 1
            else -> java.time.temporal.ChronoUnit.YEARS.between(base, from) - 1
        }.coerceAtLeast(0)
        val out = ArrayList<LocalDateTime>()
        var n = estimate
        var guard = 0
        while (out.size < MAX_AHEAD && guard++ < 2000) {
            val next = at(base, repeat, n++)
            if (next.isAfter(until)) break
            if (!next.isBefore(from)) out.add(next)
        }
        return out
    }

    // alle haken geëscaped: de reguliere expressies van Android (ICU) zijn daar strenger in dan die van Java
    private val MARKERS = Regex("^\\s*(?:[-*+]|\\d{1,9}[.)]|#{1,6}|>)\\s+(?:\\[[ xX]\\]\\s+)?")
    private val LINK_TARGET = Regex("\\]\\([^)]*\\)")
    private val FORMATTING = Regex("[*_~=`+\\[\\]\\\\]|\\{(?:yellow|green|blue|pink|purple)\\}")

    /** De kop van de melding: de titel, of de eerste regel van de tekst zonder Markdown-tekens (zoals noteHeadline op de server). */
    fun headline(title: String?, content: String?): String {
        val own = title?.trim().orEmpty()
        if (own.isNotEmpty()) return own
        return content.orEmpty().lineSequence()
            .map { it.replace(MARKERS, "").replace(LINK_TARGET, "").replace(FORMATTING, "").trim() }
            .firstOrNull { it.isNotEmpty() }
            .orEmpty()
    }
}
