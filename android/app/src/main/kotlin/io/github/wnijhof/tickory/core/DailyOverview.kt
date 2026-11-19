package io.github.wnijhof.tickory.core

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/**
 * Het ochtendoverzicht en de avondreview van Todoist, als lokale meldingen: elke dag op een gekozen tijd (Instellingen › Algemeen, in de
 * web-app) zegt de app hoeveel taken er vandaag zijn, of nog over zijn. Zonder Android, zodat het rekenen te testen is.
 */
object DailyOverview {
    enum class Kind { MORNING, EVENING }

    private val TIME = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

    /** Is dit een tijd "UU:MM" (24-uursklok)? */
    fun validTime(text: String?): Boolean = text != null && TIME.matches(text)

    /** De tijden uit je instellingen (`settings.general.morning_overview` en `evening_review`); null: uit, ook bij een ongeldige tijd. */
    fun timesOf(raw: List<Any?>?, accountId: String): Pair<String?, String?> {
        val mine = raw?.mapNotNull { Json.asObject(it) }?.firstOrNull { o ->
            !o.flag("is_deleted") && (o.text("owner_id") ?: accountId) == accountId
        } ?: return null to null
        val general = mine.obj("general") ?: return null to null
        return general.text("morning_overview")?.takeIf { validTime(it) } to general.text("evening_review")?.takeIf { validTime(it) }
    }

    /** Het eerstvolgende moment (in ms) dat het [time] ("UU:MM") is in [zone], na [nowMs]; precies nu telt als al geweest. */
    fun nextTriggerMs(nowMs: Long, zone: ZoneId, time: String): Long {
        val at = LocalTime.parse(time)
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        var next = now.toLocalDate().atTime(at).atZone(zone)
        if (!next.toInstant().isAfter(now.toInstant())) next = now.toLocalDate().plusDays(1).atTime(at).atZone(zone)
        return next.toInstant().toEpochMilli()
    }

    /** Wat er vandaag speelt: [overdue] taken te laat, [total] taken voor vandaag en te laat samen (zoals de widget Vandaag). */
    data class Summary(val overdue: Int, val total: Int)

    fun summary(snapshot: WidgetSnapshot, hidden: Set<String>, nowMs: Long, zone: ZoneId): Summary {
        val content = WidgetContentBuilder.build(snapshot, WidgetSource.Today, hidden, nowMs, zone, Lang.EN)
        return Summary(content.rows.filterIsInstance<WidgetRow.Item>().count { it.overdue }, content.count)
    }
}
