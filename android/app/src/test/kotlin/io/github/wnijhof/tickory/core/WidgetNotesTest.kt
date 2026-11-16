package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** De notities voor de notitiewidget: wat erin komt, in welke volgorde, en de tekst eronder. */
class WidgetNotesTest {
    private fun note(id: String, extra: String = "", title: String = "", content: String = "", updated: String = "2026-11-13T10:00:00Z", owner: String = "user-anna-0001") =
        """{"id":"$id","title":"$title","content":"$content","owner_id":"$owner","updated_at":"$updated"$extra}"""

    private fun body(vararg notes: String) =
        """{"me":{"id":"user-anna-0001","inbox_project_id":"inbox-project"},"tasks":[],"projects":[],"notes":[${notes.joinToString(",")}]}"""

    @Test
    fun `lezen - geen verwijderde, gearchiveerde of weggegooide, vastgepind eerst, dan de laatst gewijzigde`() {
        val snap = WidgetParser.parse(
            body(
                note("note-oud-00001", title = "Oud", updated = "2026-11-01T10:00:00Z"),
                note("note-nieuw-0001", title = "Nieuw", updated = "2026-11-12T10:00:00Z"),
                note("note-pin-00001", ",\"is_pinned\":true", title = "Vast", updated = "2026-10-01T10:00:00Z"),
                note("note-weg-00001", ",\"is_deleted\":true", title = "Verwijderd"),
                note("note-arch-0001", ",\"is_archived\":true", title = "Archief"),
                note("note-prul-0001", ",\"trashed_at\":\"2026-11-10T10:00:00Z\"", title = "Prullenbak"),
                note("kapot id!", title = "Kapot"),
            ),
        )
        assertNotNull(snap)
        assertEquals(listOf("Vast", "Nieuw", "Oud"), snap!!.notes.map { it.title })
        assertTrue(snap.notes.first().pinned)
    }

    @Test
    fun `de kop en de tekst - zonder titel is de eerste regel de kop, checklist als rondje en vinkje, zonder Markdown`() {
        val snap = WidgetParser.parse(
            body(
                note("note-lijst-001", title = "Boodschappen", content = "- [x] brood\\n- [ ] **melk**\\n\\n- [ ] appels"),
                note("note-zonder-01", content = "# Ideeën voor Texel\\nFietsen naar *de vuurtoren*\\n[Route](https://example.org)"),
            ),
        )!!
        val lijst = snap.notes.first { it.id == "note-lijst-001" }
        assertEquals("✓ brood\n○ melk\n○ appels", lijst.excerpt)
        assertEquals(1 to 3, lijst.done to lijst.total)
        val zonder = snap.notes.first { it.id == "note-zonder-01" }
        assertEquals("Ideeën voor Texel", zonder.title)
        assertEquals("Fietsen naar de vuurtoren\nRoute", zonder.excerpt)
        assertEquals(0 to 0, zonder.done to zonder.total)
    }

    @Test
    fun `gedeeld - een notitie van een ander, een onbekende achtergrond wordt de gewone kaart`() {
        val snap = WidgetParser.parse(
            body(
                note("note-bram-0001", ""","background":"teal"""", title = "Van Bram", owner = "user-bram-0002"),
                note("note-eigen-001", ""","background":"onbekend"""", title = "Eigen"),
            ),
        )!!
        assertTrue(snap.notes.first { it.id == "note-bram-0001" }.shared)
        assertEquals("teal", snap.notes.first { it.id == "note-bram-0001" }.background)
        assertFalse(snap.notes.first { it.id == "note-eigen-001" }.shared)
        assertEquals(null, snap.notes.first { it.id == "note-eigen-001" }.background)
    }

    @Test
    fun `een lange tekst wordt ingekort, en zonder notities in het antwoord is er niets`() {
        val long = WidgetNotes.excerpt("Titel", (1..20).joinToString("\n") { "Regel $it met wat tekst erin om de grens te halen" }, maxLines = 10, maxChars = 120)
        assertTrue(long.endsWith("…"))
        assertTrue(long.length <= 120)
        val none = WidgetParser.parse("""{"me":{"id":"user-anna-0001"},"tasks":[],"projects":[]}""")!!
        assertEquals(emptyList<WidgetNote>(), none.notes)
    }

    @Test
    fun `bewaren - heen en terug met notities, bewaard door een oudere versie (zonder notities) blijft leesbaar`() {
        val snap = WidgetParser.parse(body(note("note-lijst-001", ""","is_pinned":true,"background":"yellow"""", title = "Boodschappen", content = "- [x] brood")))!!
        assertEquals(snap, WidgetCodec.decode(WidgetCodec.encode(snap)))
        val older = WidgetCodec.encode(snap.copy(notes = emptyList())).replace(",\"notes\":[]", "")
        assertEquals(emptyList<WidgetNote>(), WidgetCodec.decode(older)!!.notes)
    }
}
