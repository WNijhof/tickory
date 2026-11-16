package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * De filtertaal van de widgets doet precies wat die van de web-app doet: dezelfde taken in dezelfde volgorde, dezelfde lijsten
 * en dezelfde fouten op dezelfde plek. De gevallen in filter-vectors.json komen uit de web-app (scripts/filter-vectors.ts;
 * client/core/filterVectors.test.js bewaakt dat ze bij de huidige filtertaal horen). De gegevens staan erin als sync-antwoord
 * en gaan dus ook door [WidgetParser] en heen en terug door [WidgetCodec].
 */
class FilterLangVectorsTest {
    private val data = Json.parseObject(javaClass.classLoader!!.getResource("filter-vectors.json")!!.readText())!!
    private val zone = ZoneId.of(data.text("zone")!!)
    private val snapshot = WidgetParser.parse(Json.stringify(data.obj("body")))!!

    private fun describe(o: FilterLang.Outcome): String = when (o) {
        is FilterLang.Outcome.Failed -> "fout ${o.error.code} op ${o.error.position} (${o.error.length})"
        is FilterLang.Outcome.Ok -> "taken ${o.tasks.map { it.id }}, lijsten ${o.groups.map { it.name to it.tasks.map { t -> t.id } }}, afgevinkt ${o.includesCompleted}"
    }

    private fun expected(r: Map<String, Any?>): String = if (r.flag("ok")) {
        val groups = r.list("groups")!!.map { Json.asObject(it)!! }.map { it.text("name")!! to it.list("tasks")!!.map { t -> t as String } }
        "taken ${r.list("tasks")!!.map { it as String }}, lijsten $groups, afgevinkt ${r.flag("completed")}"
    } else {
        "fout ${r.text("code")} op ${r.whole("position")} (${r.whole("length")})"
    }

    private fun check(s: WidgetSnapshot) {
        val nows = data.list("nows")!!.map { Json.asObject(it)!! }
        val cases = data.list("cases")!!.map { Json.asObject(it)!! }
        val wrong = ArrayList<String>()
        for (c in cases) {
            val query = c.text("query")!!
            val results = c.list("results")!!.map { Json.asObject(it)!! }
            for ((i, now) in nows.withIndex()) {
                val got = describe(FilterLang.evaluate(query, s, s.tasks, now.whole("ms")!!, zone))
                val want = expected(results[i])
                if (got != want) wrong.add("\"$query\" (${now.text("label")}):\n  verwacht $want\n  gekregen $got")
            }
        }
        assertTrue("${wrong.size} van ${cases.size * nows.size} verschillen met de web-app:\n" + wrong.take(25).joinToString("\n"), wrong.isEmpty())
    }

    @Test
    fun `alle gevallen uit de web-app - dezelfde taken, lijsten en fouten`() {
        assertTrue(data.list("cases")!!.size > 250)
        check(snapshot)
    }

    @Test
    fun `ook na bewaren op het toestel (heen en terug door WidgetCodec)`() {
        val restored = WidgetCodec.decode(WidgetCodec.encode(snapshot))!!
        assertEquals(snapshot, restored)
        check(restored)
    }

    @Test
    fun `wat de parser bewaart - open taken, opgeslagen filters (niet verwijderd) en de mensen`() {
        assertTrue(snapshot.tasks.none { it.id == "t-af" || it.id == "t-weg" })
        assertEquals(listOf("f-belangrijk"), snapshot.filters.map { it.id })
        assertEquals("p1 | p2", snapshot.filters.single().query)
        assertEquals(4, snapshot.users.size)
        val offerte = snapshot.tasks.single { it.id == "t-offerte" }
        assertTrue(offerte.hasReminder && offerte.deadline)
        assertEquals("user-anna-0001", offerte.assigneeId)
        assertEquals("rapport\nkwartaalcijfers en de offerte voor cem", snapshot.tasks.single { it.id == "t-rapport" }.search)
    }
}
