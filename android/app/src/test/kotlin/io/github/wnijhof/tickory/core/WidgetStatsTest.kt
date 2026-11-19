package io.github.wnijhof.tickory.core

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** De rekenregels van de widget Productiviteit: dezelfde als client/core/productivity.js. */
class WidgetStatsTest {
    // donderdag 19 november 2026
    private val today = LocalDate.parse("2026-11-19")

    private fun stats(perDay: Map<String, Int>, daily: Int = 5, weekly: Int = 25, off: List<Int> = listOf(6, 7), window: Int = 60) =
        WidgetStats("u1", perDay, daily, weekly, off, window)

    @Test
    fun `vandaag en deze week - de week begint op maandag en loopt tot en met vandaag`() {
        val s = stats(mapOf("2026-11-15" to 9, "2026-11-16" to 2, "2026-11-18" to 3, "2026-11-19" to 4, "2026-11-20" to 7))
        assertEquals(4, s.doneToday(today))
        // maandag 16 t/m donderdag 19: 2 + 3 + 4; zondag 15 (vorige week) en morgen tellen niet
        assertEquals(9, s.doneThisWeek(today))
    }

    @Test
    fun `de reeks - een gemiste werkdag breekt hem, een gemiste vrije dag en vandaag niet`() {
        // woensdag 18 en dinsdag 17 gehaald, maandag 16 gemist: reeks vanaf dinsdag
        val s = stats(mapOf("2026-11-17" to 5, "2026-11-18" to 6, "2026-11-19" to 5))
        assertEquals(3, s.dayStreak(today))
        // vandaag nog niet gehaald: de reeks blijft staan
        assertEquals(2, stats(mapOf("2026-11-17" to 5, "2026-11-18" to 6, "2026-11-19" to 1)).dayStreak(today))
        // het weekend (za 14, zo 15) mist, vrijdag 13 en maandag 16 gehaald: de reeks loopt door
        val weekend = stats(mapOf("2026-11-13" to 5, "2026-11-16" to 5, "2026-11-17" to 5, "2026-11-18" to 5, "2026-11-19" to 5))
        assertEquals(5, weekend.dayStreak(today))
        // dinsdag gemist: weg
        assertEquals(2, stats(mapOf("2026-11-16" to 5, "2026-11-18" to 5, "2026-11-19" to 5)).dayStreak(today))
    }

    @Test
    fun `een vakantie breekt de reeks niet, ook niet een lopende`() {
        // dinsdag 17 gemist: zonder vakantie is de reeks maar 2 lang; met vakantie 3 (de vakantiedag telt zelf niet mee)
        val perDay = mapOf("2026-11-16" to 5, "2026-11-18" to 5, "2026-11-19" to 5)
        assertEquals(2, stats(perDay).dayStreak(today))
        val vacation = WidgetStats.Vacation(LocalDate.parse("2026-11-17"), LocalDate.parse("2026-11-17"))
        assertEquals(3, stats(perDay).copy(vacations = listOf(vacation)).dayStreak(today))
        val running = WidgetStats.Vacation(LocalDate.parse("2026-11-17"), null)
        assertEquals(3, stats(perDay).copy(vacations = listOf(running)).dayStreak(today))
        // een vakantie na de gemiste dag helpt niet
        val late = WidgetStats.Vacation(LocalDate.parse("2026-11-18"), null)
        assertEquals(2, stats(perDay).copy(vacations = listOf(late)).dayStreak(today))
        // bewaren en teruglezen
        val back = WidgetStatsCodec.decode(WidgetStatsCodec.encode(stats(perDay).copy(vacations = listOf(vacation, running))))!!
        assertEquals(listOf(vacation, running), back.vacations)
        // een oudere bewaarde versie zonder vakanties
        assertEquals(emptyList<WidgetStats.Vacation>(), WidgetStatsCodec.decode(WidgetStatsCodec.encode(stats(perDay)).replace(",\"vacations\":[]", ""))!!.vacations)
    }

    @Test
    fun `de vakanties komen uit de algemene instellingen van de server`() {
        val sync = """{"me":{"id":"u1"},"settings":[{"goal_daily":2,"general":{"vacations":[{"from":"2026-11-17","to":"2026-11-17"},{"from":"2026-12-24","to":null},{"from":"kapot","to":null}]}}]}"""
        val statsBody = """{"days":60,"per_day":[{"date":"2026-11-18","count":2}]}"""
        val s = WidgetStatsCodec.fromResponses(sync, statsBody)!!
        assertEquals(2, s.vacations.size)
        assertEquals(LocalDate.parse("2026-12-24"), s.vacations[1].from)
        assertNull(s.vacations[1].to)
    }

    @Test
    fun `de reeks - geen dagdoel betekent geen reeks`() {
        assertNull(stats(mapOf("2026-11-19" to 3), daily = 0).dayStreak(today))
    }

    @Test
    fun `de reeks begint niet voor het begin van de gegevens`() {
        val everyDay = (0 until 10).associate { today.minusDays(it.toLong()).toString() to 5 }
        assertEquals(3, stats(everyDay, window = 3).dayStreak(today))
    }

    @Test
    fun `bewaren en teruglezen geeft dezelfde gegevens, onzin geeft niets`() {
        val s = stats(mapOf("2026-11-18" to 3, "2026-11-19" to 4), daily = 8, weekly = 40, off = listOf(7))
        assertEquals(s, WidgetStatsCodec.decode(WidgetStatsCodec.encode(s)))
        assertNull(WidgetStatsCodec.decode(null))
        assertNull(WidgetStatsCodec.decode("geen json"))
        assertNull(WidgetStatsCodec.decode("""{"v":99,"account":"u1","perDay":{}}"""))
    }

    private val syncBody = """{"me":{"id":"u1"},"settings":[{"id":"s","goal_daily":8,"goal_weekly":null,"days_off":[7]}]}"""
    private val statsBody = """{"tz":"Europe/Amsterdam","today":"2026-11-19","days":14,"per_day":[{"date":"2026-11-18","count":3},{"date":"2026-11-19","count":4}]}"""

    @Test
    fun `van de antwoorden van de server - doelen uit de instellingen, een ontbrekend doel is de standaard`() {
        val s = WidgetStatsCodec.fromResponses(syncBody, statsBody)
        assertNotNull(s)
        assertEquals(WidgetStats("u1", mapOf("2026-11-18" to 3, "2026-11-19" to 4), 8, WidgetStats.DEFAULT_WEEKLY, listOf(7), 14), s)
    }

    @Test
    fun `ongeldige doelen en vrije dagen worden de standaard`() {
        val bad = """{"me":{"id":"u1"},"settings":[{"goal_daily":101,"goal_weekly":-1,"days_off":[1,2,3,4,5,6,7]}]}"""
        val s = WidgetStatsCodec.fromResponses(bad, statsBody)!!
        assertEquals(WidgetStats.DEFAULT_DAILY, s.goalDaily)
        assertEquals(WidgetStats.DEFAULT_WEEKLY, s.goalWeekly)
        assertEquals(WidgetStats.DEFAULT_DAYS_OFF, s.daysOff)
    }

    @Test
    fun `een antwoord zonder gebruiker of zonder dagen geeft niets`() {
        assertNull(WidgetStatsCodec.fromResponses("""{"settings":[]}""", statsBody))
        assertNull(WidgetStatsCodec.fromResponses(syncBody, """{"days":14}"""))
        assertNull(WidgetStatsCodec.fromResponses(syncBody, null))
    }
}
