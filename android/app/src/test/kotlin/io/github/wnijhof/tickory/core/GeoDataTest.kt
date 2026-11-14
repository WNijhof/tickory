package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.FakeServer.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Plaatsen en herinneringen op een plek in de gegevens van de server, de opslag en de scripts naar de pagina. */
class GeoDataTest {
    private fun body(places: String = "[]", reminders: String = "[]", tasks: String = """[{"id":"task-0001","content":"Pakket","due":null,"checked":false,"is_deleted":false}]""") =
        """{"sync_token":"9","tasks":$tasks,"reminders":$reminders,"places":$places}"""

    private val locationReminder = """{"id":"rem-00001","task_id":"task-0001","type":"location","minute_offset":null,"due":null,"place_id":"place-home-1","trigger":"enter","is_deleted":false}"""
    private val homeJson = """{"id":"place-home-1","name":"Thuis","lat":52.0907,"lon":5.1214,"radius":150,"is_deleted":false}"""

    // ---------- lezen uit het antwoord van de server ----------

    @Test
    fun `plaatsen en locatieherinneringen worden gelezen`() {
        val snapshot = SyncParser.parseSnapshot(body(places = "[$homeJson]", reminders = "[$locationReminder]"))!!
        assertEquals(listOf(PlaceInfo("place-home-1", "Thuis", 52.0907, 5.1214, 150)), snapshot.places)
        val r = snapshot.reminders.single()
        assertEquals("location", r.type)
        assertEquals("place-home-1", r.placeId)
        assertEquals("enter", r.trigger)
        assertNull(r.minuteOffset)
    }

    @Test
    fun `een oudere server kent geen plaatsen - dat is gewoon een lege lijst`() {
        val snapshot = SyncParser.parseSnapshot("""{"tasks":[],"reminders":[]}""")!!
        assertTrue(snapshot.places.isEmpty())
    }

    @Test
    fun `een kapotte plaats wordt overgeslagen, de rest blijft`() {
        val places = listOf(
            homeJson,
            """{"id":"place-bad-1","name":"Geen straal","lat":52.0,"lon":5.0,"is_deleted":false}""",
            """{"id":"place-bad-2","name":"Tekst","lat":"52","lon":5.0,"radius":150,"is_deleted":false}""",
            """{"id":"place-bad-3","name":"Te noord","lat":95.0,"lon":5.0,"radius":150,"is_deleted":false}""",
            """{"id":"bad id!","name":"Rare id","lat":52.0,"lon":5.0,"radius":150,"is_deleted":false}""",
            """{"name":"Zonder id","lat":52.0,"lon":5.0,"radius":150}""",
            "5",
        ).joinToString(",", "[", "]")
        assertEquals(listOf("place-home-1"), SyncParser.parseSnapshot(body(places = places))!!.places.map { it.id })
    }

    @Test
    fun `gehele getallen als coordinaten zijn gewoon getallen`() {
        val p = SyncParser.parseSnapshot(body(places = """[{"id":"place-eq-001","name":"Evenaar","lat":0,"lon":-180,"radius":100,"is_deleted":false}]"""))!!.places.single()
        assertEquals(0.0, p.lat, 0.0)
        assertEquals(-180.0, p.lon, 0.0)
    }

    @Test
    fun `een verwijderde plaats komt zonder inhoud mee`() {
        val p = SyncParser.parseSnapshot(body(places = """[{"id":"place-home-1","is_deleted":true}]"""))!!.places.single()
        assertTrue(p.deleted)
    }

    @Test
    fun `de naam van een plaats wordt op een regel gehouden`() {
        val p = SyncParser.parseSnapshot(body(places = """[{"id":"place-nm-001","name":"  Thuis \n  en meer ","lat":52.0,"lon":5.0,"radius":150,"is_deleted":false}]"""))!!.places.single()
        assertEquals("Thuis en meer", p.name)
    }

    // ---------- wat bewaard wordt ----------

    @Test
    fun `alleen de plaatsen met een herinnering worden bewaard`() {
        val snapshot = SyncParser.parseSnapshot(
            body(
                places = """[$homeJson,{"id":"place-work-1","name":"Werk","lat":52.5,"lon":5.5,"radius":200,"is_deleted":false}]""",
                reminders = "[$locationReminder]",
            ),
        )!!.trimmed()
        assertEquals(listOf("place-home-1"), snapshot.places.map { it.id })
        assertEquals(listOf("rem-00001"), snapshot.reminders.map { it.id })
    }

    @Test
    fun `geen plaatsen bewaren als er geen locatieherinneringen zijn`() {
        val snapshot = SyncParser.parseSnapshot(body(places = "[$homeJson]", reminders = """[{"id":"rem-00002","task_id":"task-0001","type":"relative","minute_offset":30,"due":null,"is_deleted":false}]"""))!!.trimmed()
        assertTrue(snapshot.places.isEmpty())
    }

    @Test
    fun `de toestand van de herinneringen heen en terug, met plaatsen en uitgestelde meldingen op een plek`() {
        val state = ReminderState(
            snapshot = SyncSnapshot(
                listOf(TaskInfo("task-0001", "Pakket", null)),
                listOf(ReminderInfo("rem-00001", "task-0001", "location", null, null, false, "place-home-1", "leave")),
                listOf(PlaceInfo("place-home-1", "Thuis", 52.0907, 5.1214, 150)),
            ),
            snoozed = mapOf("rem-00001" to SnoozedReminder("rem-00001", "task-0001", "Pakket", null, 1_000L, 2_000L, "Thuis", "leave")),
            pendingCompletes = mapOf("rem-00001" to PendingComplete(PlannedReminder("rem-00001", "task-0001", "Pakket", 1_000L, null, "Thuis", "leave"), 1_500L)),
        )
        val decoded = StateCodec.decode(StateCodec.encode(state))
        assertEquals(state.snapshot, decoded.snapshot)
        assertEquals(state.snoozed, decoded.snoozed)
        assertEquals(state.pendingCompletes, decoded.pendingCompletes)
        assertEquals("Thuis", decoded.snoozed.getValue("rem-00001").asPlanned().place)
    }

    @Test
    fun `een bewaarde toestand van een oudere versie zonder plaatsen blijft leesbaar`() {
        val old = """{"v":1,"tasks":[{"id":"task-0001","content":"Oud","due":null,"checked":false,"deleted":false}],"reminders":[{"id":"rem-00001","task":"task-0001","type":"relative","offset":30,"due":null,"deleted":false}],"scheduled":[],"snoozed":[],"shown":{},"completes":[]}"""
        val state = StateCodec.decode(old)
        assertEquals(1, state.snapshot.reminders.size)
        assertTrue(state.snapshot.places.isEmpty())
        assertNull(state.snapshot.reminders[0].placeId)
    }

    // ---------- opvragen bij de server ----------

    @Test
    fun `een server die plaatsen niet kent weigert het verzoek - dan vraagt de app zonder plaatsen opnieuw`() {
        val tasks = body(places = "[]")
        var calls = 0
        FakeServer { request ->
            calls += 1
            if (Json.parseObject(request.body)!!.list("resource_types")!!.contains("places")) {
                Response(400, """{"error_code":"INVALID_REQUEST","error":"onbekend resourcetype \"places\""}""")
            } else {
                Response(200, tasks)
            }
        }.use { server ->
            val result = ApiClient(server.origin, 5_000, 5_000).fetchSnapshot("tky_test")
            assertTrue("$result", result is FetchResult.Ok)
            assertEquals(2, server.requests.size)
            assertFalse((Json.parseObject(server.requests[1].body)!!.list("resource_types")!!).contains("places"))
        }
        assertEquals(2, calls)
    }

    @Test
    fun `een echte fout bij plaatsen wordt niet verbloemd`() {
        FakeServer { Response(500, "{}") }.use { server ->
            assertEquals(FetchResult.Failed(null, 500), ApiClient(server.origin, 5_000, 5_000).fetchSnapshot("tky_test"))
            assertEquals("geen tweede poging bij een serverfout", 1, server.requests.size)
        }
    }

    // ---------- het script naar de pagina ----------

    @Test
    fun `het script met de positie bevat alleen getallen`() {
        assertEquals(
            "window.dispatchEvent(new CustomEvent(\"tickory-position\",{detail:{lat:52.0907,lon:5.1214,accuracy:12.5}}));",
            PositionScript.result(52.0907, 5.1214, 12.5f),
        )
        assertEquals("window.dispatchEvent(new CustomEvent(\"tickory-position\",{detail:{lat:-33.8688,lon:151.2093}}));", PositionScript.result(-33.8688, 151.2093, null))
        assertEquals("window.dispatchEvent(new CustomEvent(\"tickory-position\",{detail:{lat:-33.8688,lon:151.2093}}));", PositionScript.result(-33.8688, 151.2093, Float.NaN))
    }

    @Test
    fun `een onmogelijke positie en onbekende fouten worden een vaste foutcode`() {
        assertTrue(PositionScript.result(95.0, 5.0, 1f).contains("error:\"unavailable\""))
        assertTrue(PositionScript.result(Double.NaN, 5.0, 1f).contains("error:\"unavailable\""))
        for (code in listOf("denied", "unavailable", "timeout")) assertTrue(PositionScript.error(code).contains("error:\"$code\""))
        val injected = PositionScript.error("\"});alert(1);({\"")
        assertEquals("window.dispatchEvent(new CustomEvent(\"tickory-position\",{detail:{error:\"unavailable\"}}));", injected)
    }
}
