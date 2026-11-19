package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.amsterdam
import io.github.wnijhof.tickory.core.WidgetFixtures.at
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Het ochtendoverzicht en de avondreview: de tijd van het volgende alarm en wat de melding zegt. */
class DailyOverviewTest {
    @Test
    fun `een tijd is UU en MM op de 24-uursklok`() {
        for (ok in listOf("00:00", "08:30", "23:59")) assertTrue(ok, DailyOverview.validTime(ok))
        for (bad in listOf(null, "", "8:30", "24:00", "12:60", "12-30", "12:30:00", "ochtend")) assertFalse(bad.toString(), DailyOverview.validTime(bad))
    }

    @Test
    fun `het volgende alarm - vandaag als de tijd nog komt, anders morgen`() {
        val now = at("2026-11-13T09:00")
        assertEquals(at("2026-11-13T18:00"), DailyOverview.nextTriggerMs(now, amsterdam, "18:00"))
        assertEquals(at("2026-11-14T08:00"), DailyOverview.nextTriggerMs(now, amsterdam, "08:00"))
        assertEquals("precies nu telt als geweest", at("2026-11-14T09:00"), DailyOverview.nextTriggerMs(now, amsterdam, "09:00"))
        // de zomertijd verschuift niets: 08:00 blijft 08:00 op de klok, ook als de nacht 25 uur duurt
        assertEquals(at("2026-10-25T08:00"), DailyOverview.nextTriggerMs(at("2026-10-24T09:00"), amsterdam, "08:00"))
    }

    @Test
    fun `de tijden komen uit je algemene instellingen, ongeldig of van een ander is uit`() {
        val me = "\"owner_id\":\"user-anna-0001\",\"is_deleted\":false"
        fun times(settings: String): Pair<String?, String?> = DailyOverview.timesOf(Json.parse(settings) as List<Any?>, "user-anna-0001")
        assertEquals("08:00" to "18:30", times("""[{"id":"s",$me,"general":{"morning_overview":"08:00","evening_review":"18:30"}}]"""))
        assertEquals("08:00" to null, times("""[{"id":"s",$me,"general":{"morning_overview":"08:00","evening_review":null}}]"""))
        assertEquals(null to null, times("""[{"id":"s",$me,"general":{"morning_overview":"ochtend"}}]"""))
        assertEquals(null to null, times("""[{"id":"s",$me,"general":null}]"""))
        assertEquals(null to null, times("""[{"id":"s9","owner_id":"user-bob","is_deleted":false,"general":{"morning_overview":"08:00"}}]"""))
        assertEquals(null to null, DailyOverview.timesOf(null, "user-anna-0001"))
    }

    @Test
    fun `de samenvatting telt wat vandaag moet en wat te laat is, zonder wat al afgevinkt in de wachtrij staat`() {
        val s = snapshot(listOf(task("oud", "2026-11-12"), task("nu", "2026-11-13"), task("later", "2026-11-20"), task("zonder")))
        val now = at("2026-11-13T09:00")
        assertEquals(DailyOverview.Summary(overdue = 1, total = 2), DailyOverview.summary(s, emptySet(), now, amsterdam))
        assertEquals(DailyOverview.Summary(overdue = 0, total = 1), DailyOverview.summary(s, setOf("oud"), now, amsterdam))
        assertEquals(DailyOverview.Summary(0, 0), DailyOverview.summary(snapshot(), emptySet(), now, amsterdam))
        assertNull(DailyOverview.timesOf(null, "x").first)
    }
}
