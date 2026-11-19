package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** De regels van de wachtrij van het kleine venster Notitie toevoegen (zonder Android). */
class QuickNoteQueueTest {
    private fun note(uuid: String = "tickory-n-aaaaaaaaaaaaaaaaaaaaaaaa", account: String? = "u1", session: String = "s1", at: Long = 1_000L, title: String = "Boodschappen", content: String = "- [ ] melk", pinned: Boolean = false) =
        QueuedNote(uuid, "note0000000001a", title, content, pinned, account, session, at)

    @Test
    fun `een uuid en een notitie-id hebben de vorm die de server vraagt`() {
        val uuid = QuickNoteQueue.newUuid()
        assertTrue(uuid, Regex("^tickory-n-[0-9a-f]{24}$").matches(uuid))
        val id = QuickNoteQueue.newNoteId()
        assertTrue(id, Regex("^[a-z0-9]{16}$").matches(id))
        assertTrue("een nieuw id is bijna zeker anders", QuickNoteQueue.newNoteId() != id)
    }

    @Test
    fun `de rij neemt een notitie aan, geen dubbel uuid en niet meer dan het maximum`() {
        val (one, added) = QuickNoteQueue.enqueue(emptyList(), note())
        assertTrue(added)
        assertEquals(1, one.size)
        assertFalse("hetzelfde uuid nog eens", QuickNoteQueue.enqueue(one, note()).second)
        var full: List<QueuedNote> = emptyList()
        repeat(QuickNoteQueue.MAX_ITEMS) { i -> full = QuickNoteQueue.enqueue(full, note(uuid = "tickory-n-%024d".format(i))).first }
        assertEquals(QuickNoteQueue.MAX_ITEMS, full.size)
        assertFalse("de rij is vol", QuickNoteQueue.enqueue(full, note(uuid = "tickory-n-zzzzzzzzzzzzzzzzzzzzzzzz")).second)
    }

    @Test
    fun `afhandelen haalt uit de rij, en wat te lang wacht vervalt`() {
        val old = note(uuid = "tickory-n-oud000000000000000000000", at = 1_000L)
        val fresh = note(uuid = "tickory-n-nieuw0000000000000000000", at = QuickNoteQueue.RETENTION_MS)
        val items = listOf(old, fresh)
        assertEquals(listOf(old), QuickNoteQueue.expired(items, QuickNoteQueue.RETENTION_MS + 2_000L))
        assertEquals(listOf(fresh), QuickNoteQueue.settle(items, setOf(old.uuid)))
    }

    @Test
    fun `alleen van deze gebruiker (of onder dezelfde aanmelding zonder bekende gebruiker) wordt verstuurd`() {
        val mine = note(uuid = "tickory-n-mijn00000000000000000000", account = "u1")
        val other = note(uuid = "tickory-n-ander0000000000000000000", account = "u2")
        val unknownSame = note(uuid = "tickory-n-onbekend00000000000000", account = null, session = "s1")
        val unknownOther = note(uuid = "tickory-n-onbekend20000000000000", account = null, session = "s2")
        val all = listOf(mine, other, unknownSame, unknownOther)
        assertEquals(listOf(mine, unknownSame), QuickNoteQueue.sendable(all, "u1", "s1"))
        assertEquals(listOf(other, unknownOther), QuickNoteQueue.foreign(all, "u1", "s1"))
        assertEquals("zonder bekende gebruiker niets van een gebruiker", listOf(unknownSame), QuickNoteQueue.sendable(all, null, "s1"))
    }

    @Test
    fun `het commando heeft alleen wat is ingevuld`() {
        assertEquals(mapOf("id" to "note0000000001a", "title" to "Boodschappen", "content" to "- [ ] melk"), QuickNoteQueue.args(note()))
        assertEquals(mapOf("id" to "note0000000001a", "is_pinned" to true), QuickNoteQueue.args(note(title = "", content = "", pinned = true)))
        assertTrue(QuickNoteQueue.isEmpty("  ", "\n"))
        assertFalse(QuickNoteQueue.isEmpty("", "x"))
    }

    @Test
    fun `bewaren en teruglezen geeft dezelfde rij, en kapotte regels en onzin vallen weg`() {
        val items = listOf(note(), note(uuid = "tickory-n-bbbbbbbbbbbbbbbbbbbbbbbb", account = null, pinned = true, content = "regel 1\nregel \"2\""))
        assertEquals(items, QuickNoteQueue.decode(QuickNoteQueue.encode(items)))
        assertEquals(emptyList<QueuedNote>(), QuickNoteQueue.decode(null))
        assertEquals(emptyList<QueuedNote>(), QuickNoteQueue.decode("geen json"))
        assertEquals(emptyList<QueuedNote>(), QuickNoteQueue.decode("""{"v":2,"items":[]}"""))
        val bad = """{"v":1,"items":[{"uuid":"kort","note":"note0000000001a","at":1},{"uuid":"tickory-n-cccccccccccccccccccccccc","note":"a b","at":1},{"uuid":"tickory-n-dddddddddddddddddddddddd","note":"note0000000001a"}]}"""
        assertEquals("een slecht uuid, een slecht id en een ontbrekende tijd", emptyList<QueuedNote>(), QuickNoteQueue.decode(bad))
    }
}
