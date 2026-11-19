package io.github.wnijhof.tickory.quicknote

import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.ToggleButton
import io.github.wnijhof.tickory.AddNoteTileService
import io.github.wnijhof.tickory.AppShortcuts
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.QueuedNote
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.store.QuickNoteStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.QuickNoteSync
import io.github.wnijhof.tickory.widget.WidgetTestBase
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowToast

/** Het kleine venster "Notitie toevoegen" op een nagebootst Android: openen, toevoegen (met en zonder verbinding), sluiten, versturen. */
class QuickNoteActivityTest : WidgetTestBase() {
    private val data = snapshot(projects = listOf(project("inbox-project", "Inbox")))
    private var online = true
    private val originalOnline = QuickNoteActivity.isOnline

    @Before
    fun setUp() {
        QuickNoteActivity.isOnline = { online }
    }

    @After
    fun tearDown() {
        QuickNoteActivity.isOnline = originalOnline
    }

    private fun open() = Robolectric.buildActivity(QuickNoteActivity::class.java, QuickNoteActivity.launchIntent(app)).setup()

    private val QuickNoteActivity.titleInput get() = findViewById<EditText>(R.id.note_title)
    private val QuickNoteActivity.bodyInput get() = findViewById<EditText>(R.id.note_body)
    private val QuickNoteActivity.pin get() = findViewById<ToggleButton>(R.id.note_pin)
    private val QuickNoteActivity.add get() = findViewById<Button>(R.id.note_add)
    private val QuickNoteActivity.status get() = findViewById<TextView>(R.id.note_status)

    @Test
    fun `opent met de focus in de titel, en Toevoegen pas met tekst`() {
        signIn(withData = data)
        val a = open().get()
        assertTrue(a.titleInput.isFocused)
        assertFalse(a.add.isEnabled)
        a.titleInput.setText("   ")
        assertFalse(a.add.isEnabled)
        a.bodyInput.setText("alleen tekst")
        assertTrue("alleen tekst is genoeg", a.add.isEnabled)
    }

    @Test
    fun `toevoegen zet de notitie in de wachtrij, wist het concept, sluit en zegt het`() {
        signIn(withData = data)
        val controller = open()
        val a = controller.get()
        a.titleInput.setText("Boodschappen")
        a.bodyInput.setText("- [ ] melk\n- [ ] brood")
        a.pin.isChecked = true
        a.add.performClick()
        val queue = QuickNoteStore.queue(app)
        assertEquals(1, queue.size)
        assertEquals("Boodschappen", queue[0].title)
        assertEquals("- [ ] melk\n- [ ] brood", queue[0].content)
        assertTrue(queue[0].pinned)
        assertEquals(WidgetStore.snapshot(app)?.accountId, queue[0].accountId)
        assertNull("het concept is weg", QuickNoteStore.draft(app, queue[0].accountId))
        assertTrue(a.isFinishing)
        assertEquals("Notitie toegevoegd", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun `zonder verbinding zegt het venster dat de notitie wordt verstuurd zodra die er is`() {
        signIn(withData = data)
        online = false
        val a = open().get()
        a.titleInput.setText("Later")
        a.add.performClick()
        assertEquals(1, QuickNoteStore.queue(app).size)
        assertEquals("Notitie bewaard, wordt verstuurd zodra er verbinding is", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun `terug sluit zonder toe te voegen en bewaart de tekst als concept, dat de volgende keer terugkomt`() {
        signIn(withData = data)
        val controller = open()
        val a = controller.get()
        a.titleInput.setText("Half")
        a.bodyInput.setText("nog niet af")
        a.pin.isChecked = true
        a.onBackPressedDispatcher.onBackPressed()
        assertTrue(a.isFinishing)
        assertEquals(0, QuickNoteStore.queue(app).size)
        assertEquals("Concept bewaard", ShadowToast.getTextOfLatestToast())

        val again = open().get()
        assertEquals("Half", again.titleInput.text.toString())
        assertEquals("nog niet af", again.bodyInput.text.toString())
        assertTrue(again.pin.isChecked)
        assertEquals("Je onaffe notitie is terug", again.status.text.toString())
    }

    @Test
    fun `de knop Checklist zet een regel met een vakje, onder een regel met tekst een nieuwe`() {
        signIn(withData = data)
        val a = open().get()
        a.bodyInput.requestFocus()
        a.findViewById<Button>(R.id.note_checklist).performClick()
        assertEquals("- [ ] ", a.bodyInput.text.toString())
        a.bodyInput.text.insert(a.bodyInput.text.length, "melk")
        a.findViewById<Button>(R.id.note_checklist).performClick()
        assertEquals("- [ ] melk\n- [ ] ", a.bodyInput.text.toString())
    }

    @Test
    fun `zonder aanmelding opent de app op een nieuwe notitie`() {
        val controller = Robolectric.buildActivity(QuickNoteActivity::class.java, QuickNoteActivity.launchIntent(app)).create()
        val started = shadowOf(app).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals(AppShortcuts.ACTION, started.action)
        assertEquals("note=new", DeepLink.view(started.getStringExtra(DeepLink.EXTRA_VIEW)))
        assertTrue(controller.get().isFinishing)
    }

    @Test
    fun `de tegel en de snelkoppeling openen dit venster`() {
        assertEquals(QuickNoteActivity::class.java.name, QuickNoteActivity.launchIntent(app).component!!.className)
        val shortcut = AppShortcuts.build(app).first { it.id == AppShortcuts.NOTE }
        assertEquals(QuickNoteActivity::class.java.name, shortcut.intent.component!!.className)
        assertNotNull(AddNoteTileService::class.java)
    }

    // ---------- versturen ----------

    private fun queued(account: String?, uuid: String = QuickAddQueueTestUuid.next()): QueuedNote =
        QueuedNote(uuid, "note0000000001a", "Titel", "Tekst", false, account, QuickAddQueue.sessionTag(token), io.github.wnijhof.tickory.reminders.AppClock.now())

    private object QuickAddQueueTestUuid {
        private var n = 0
        fun next(): String = "tickory-n-%024d".format(++n)
    }

    private fun client(origin: String) = ApiClient(origin, 2_000, 4_000, null)

    @Test
    fun `versturen - het commando note_add gaat naar de server en de notitie verdwijnt uit de wachtrij`() {
        FakeServer { request ->
            val uuid = Regex("\"uuid\":\"([^\"]+)\"").find(request.body)!!.groupValues[1]
            Response(200, """{"sync_token":"1","sync_status":{"$uuid":"ok"}}""")
        }.use { server ->
            signIn(server.origin, data)
            val item = queued(WidgetStore.snapshot(app)!!.accountId)
            assertTrue(QuickNoteStore.enqueue(app, item))
            assertEquals(QuickNoteSync.Outcome.SENT, QuickNoteSync.flush(app, client(server.origin), token))
            assertEquals(0, QuickNoteStore.queue(app).size)
            val body = server.requests.last().body
            assertTrue(body, body.contains("\"note_add\"") && body.contains("\"title\":\"Titel\"") && body.contains("\"content\":\"Tekst\"") && body.contains("\"id\":\"note0000000001a\""))
            assertEquals(QuickNoteSync.Outcome.NOTHING, QuickNoteSync.flush(app, client(server.origin), token))
        }
    }

    @Test
    fun `versturen - zonder verbinding blijft de notitie staan, met hetzelfde uuid voor de volgende keer`() {
        signIn(FakeServer.closedPortOrigin(), data)
        val item = queued(WidgetStore.snapshot(app)!!.accountId)
        QuickNoteStore.enqueue(app, item)
        assertEquals(QuickNoteSync.Outcome.OFFLINE, QuickNoteSync.flush(app, client(FakeServer.closedPortOrigin()), token))
        assertEquals(listOf(item), QuickNoteStore.queue(app))
    }

    @Test
    fun `versturen - een weigering haalt de notitie uit de rij en geeft de tekst terug als concept`() {
        FakeServer { request ->
            val uuid = Regex("\"uuid\":\"([^\"]+)\"").find(request.body)!!.groupValues[1]
            Response(200, """{"sync_token":"1","sync_status":{"$uuid":{"error_code":"LIMIT_REACHED","error":"te veel"}}}""")
        }.use { server ->
            signIn(server.origin, data)
            val account = WidgetStore.snapshot(app)!!.accountId
            QuickNoteStore.enqueue(app, queued(account))
            assertEquals(QuickNoteSync.Outcome.SENT, QuickNoteSync.flush(app, client(server.origin), token))
            assertEquals(0, QuickNoteStore.queue(app).size)
            assertEquals("de tekst is niet kwijt", "Titel", QuickNoteStore.draft(app, account)?.title)
        }
    }

    @Test
    fun `versturen - een notitie van een andere gebruiker gaat nooit onder deze aanmelding`() {
        FakeServer { Response(200, """{"sync_token":"1","sync_status":{}}""") }.use { server ->
            signIn(server.origin, data)
            QuickNoteStore.enqueue(app, queued("someone-else"))
            QuickNoteSync.flush(app, client(server.origin), token)
            assertEquals(0, QuickNoteStore.queue(app).size)
            assertTrue("er is niets verstuurd", server.requests.isEmpty())
        }
    }

    @Test
    fun `afmelden wist de wachtrij en het concept`() {
        signIn(withData = data)
        QuickNoteStore.enqueue(app, queued(WidgetStore.snapshot(app)!!.accountId))
        QuickNoteStore.saveDraft(app, null, QuickNoteStore.Draft("x", "y", false))
        val left = QuickNoteStore.clearAll(app)
        assertEquals(1, left.size)
        assertEquals(0, QuickNoteStore.queue(app).size)
        assertNull(QuickNoteStore.draft(app, null))
    }
}
