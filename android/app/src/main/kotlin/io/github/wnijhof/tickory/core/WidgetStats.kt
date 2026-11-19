package io.github.wnijhof.tickory.core

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * De gegevens voor de widget Productiviteit: hoeveel taken je per dag afvinkte (de laatste dagen, uit `GET /api/v1/stats`) en je
 * doelen (uit de instellingen). Zonder Android, zodat het rekenen te testen is. De regels zijn die van de web-app
 * (client/core/productivity.js): een dag telt voor de reeks als het dagdoel gehaald is, een gemiste vrije dag breekt de reeks
 * niet, vandaag breekt nog niet; doel 0 betekent uit.
 *
 * @param perDay datum 'YYYY-MM-DD' naar het aantal afvinkingen (alleen dagen met minstens één)
 * @param daysOff vrije dagen, ISO: 1 = maandag … 7 = zondag
 * @param vacations vakantieperiodes (`settings.general.vacations`): een gemiste dag erin breekt de reeks niet; `to` null = loopt nog
 * @param windowDays hoeveel dagen terug de gegevens gaan; een reeks kan niet langer lijken dan dit
 */
data class WidgetStats(
    val accountId: String,
    val perDay: Map<String, Int>,
    val goalDaily: Int,
    val goalWeekly: Int,
    val daysOff: List<Int>,
    val windowDays: Int,
    val vacations: List<Vacation> = emptyList(),
) {
    /** Een vakantie: van [from] tot en met [to] (null: loopt nog). */
    data class Vacation(val from: LocalDate, val to: LocalDate?) {
        operator fun contains(day: LocalDate): Boolean = !day.isBefore(from) && (to == null || !day.isAfter(to))
    }

    private fun onVacation(day: LocalDate): Boolean = vacations.any { day in it }

    fun doneOn(day: LocalDate): Int = perDay[day.toString()] ?: 0

    /** Vandaag afgevinkt. */
    fun doneToday(today: LocalDate): Int = doneOn(today)

    /** Deze week (ISO: maandag tot en met vandaag). */
    fun doneThisWeek(today: LocalDate): Int {
        var total = 0
        var day = today.with(DayOfWeek.MONDAY)
        while (!day.isAfter(today)) {
            total += doneOn(day)
            day = day.plusDays(1)
        }
        return total
    }

    /** Het aantal dagen achter elkaar (tot en met vandaag) dat het dagdoel gehaald is; null als het dagdoel uit staat. */
    fun dayStreak(today: LocalDate): Int? {
        if (goalDaily <= 0) return null
        var run = 0
        var day = today.minusDays((windowDays - 1).toLong())
        while (!day.isAfter(today)) {
            when {
                doneOn(day) >= goalDaily -> run += 1
                day != today && day.dayOfWeek.value !in daysOff && !onVacation(day) -> run = 0
            }
            day = day.plusDays(1)
        }
        return run
    }

    companion object {
        const val DEFAULT_DAILY = 5
        const val DEFAULT_WEEKLY = 25
        val DEFAULT_DAYS_OFF = listOf(6, 7)
        const val MAX_DAILY = 100
        const val MAX_WEEKLY = 700
    }
}

/** Van en naar tekst (het bestand op het toestel) en van de antwoorden van de server naar [WidgetStats]. */
object WidgetStatsCodec {
    private const val VERSION = 1L

    fun encode(s: WidgetStats): String = Json.stringify(
        mapOf(
            "v" to VERSION, "account" to s.accountId, "daily" to s.goalDaily.toLong(), "weekly" to s.goalWeekly.toLong(),
            "off" to s.daysOff.map { it.toLong() }, "window" to s.windowDays.toLong(),
            "vacations" to s.vacations.map { listOf(it.from.toString(), it.to?.toString()) },
            "perDay" to s.perDay.mapValues { it.value.toLong() },
        ),
    )

    fun decode(text: String?): WidgetStats? {
        val root = Json.parseObject(text) ?: return null
        if (root.whole("v") != VERSION) return null
        val account = root.text("account") ?: return null
        val perDay = root.obj("perDay")?.mapNotNull { (k, v) -> (v as? Number)?.toInt()?.let { k to it } }?.toMap() ?: return null
        val off = root.list("off")?.mapNotNull { (it as? Number)?.toInt() } ?: WidgetStats.DEFAULT_DAYS_OFF
        return WidgetStats(
            account, perDay, root.whole("daily")?.toInt() ?: WidgetStats.DEFAULT_DAILY, root.whole("weekly")?.toInt() ?: WidgetStats.DEFAULT_WEEKLY,
            off, root.whole("window")?.toInt() ?: 60, root.list("vacations")?.mapNotNull { vacationOf(it) } ?: emptyList(),
        )
    }

    private fun vacationOf(raw: Any?): WidgetStats.Vacation? {
        val pair = (raw as? List<*>)?.takeIf { it.size == 2 } ?: return null
        val from = runCatching { LocalDate.parse(pair[0] as? String) }.getOrNull() ?: return null
        val to = (pair[1] as? String)?.let { runCatching { LocalDate.parse(it) }.getOrNull() ?: return null }
        return WidgetStats.Vacation(from, to)
    }

    /** De vakanties uit `settings.general.vacations`; een ongeldige periode telt niet. */
    fun vacationsOf(settings: Map<String, Any?>?): List<WidgetStats.Vacation> =
        (settings?.let { Json.asObject(it["general"]) }?.list("vacations") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            val from = runCatching { LocalDate.parse(o.text("from")) }.getOrNull() ?: return@mapNotNull null
            val to = o.text("to")?.let { runCatching { LocalDate.parse(it) }.getOrNull() ?: return@mapNotNull null }
            WidgetStats.Vacation(from, to)
        }

    /**
     * Uit de antwoorden van `POST /sync` met alleen `settings` (de doelen, `me.id`) en `GET /stats` (`per_day`).
     * Een doel dat ontbreekt of buiten de grenzen valt, wordt de standaard (zoals `goalsOf` in shared/stats.js).
     */
    fun fromResponses(syncBody: String?, statsBody: String?): WidgetStats? {
        val sync = Json.parseObject(syncBody) ?: return null
        val stats = Json.parseObject(statsBody) ?: return null
        val account = sync.obj("me")?.text("id") ?: return null
        val settings = sync.list("settings")?.firstNotNullOfOrNull { Json.asObject(it) }
        fun goal(key: String, max: Int, fallback: Int): Int = settings?.whole(key)?.toInt()?.takeIf { it in 0..max } ?: fallback
        val off = settings?.list("days_off")?.mapNotNull { (it as? Number)?.toInt() }
            ?.takeIf { l -> l.size <= 6 && l.all { it in 1..7 } && l.toSet().size == l.size }?.sorted() ?: WidgetStats.DEFAULT_DAYS_OFF
        val perDay = stats.list("per_day")?.mapNotNull { row ->
            val o = Json.asObject(row) ?: return@mapNotNull null
            val date = o.text("date") ?: return@mapNotNull null
            o.whole("count")?.toInt()?.let { date to it }
        }?.toMap() ?: return null
        return WidgetStats(
            account, perDay, goal("goal_daily", WidgetStats.MAX_DAILY, WidgetStats.DEFAULT_DAILY), goal("goal_weekly", WidgetStats.MAX_WEEKLY, WidgetStats.DEFAULT_WEEKLY),
            off, stats.whole("days")?.toInt() ?: 60, vacationsOf(settings),
        )
    }
}
