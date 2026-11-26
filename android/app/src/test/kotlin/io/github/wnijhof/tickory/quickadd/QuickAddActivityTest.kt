package io.github.wnijhof.tickory.quickadd

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ToggleButton
import androidx.work.ListenableWorker
import androidx.work.testing.TestWorkerBuilder
import androidx.work.workDataOf
import io.github.wnijhof.tickory.AddTaskTileService
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.syncBody
import io.github.wnijhof.tickory.core.text
import io.github.wnijhof.tickory.store.QuickAddStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncWorker
import io.github.wnijhof.tickory.widget.WidgetIntents
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowToast
import java.time.Duration
import java.util.Base64
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** Het kleine venster "Taak toevoegen" op een nagebootst Android: openen, kiezen, toevoegen (met en zonder verbinding), sluiten. */
class QuickAddActivityTest : WidgetTestBase() {
    private val data = snapshot(
        projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk", order = "a"), project("thuis", "Thuis", order = "b"), project("gedeeld", "Gedeeld", readOnly = true, order = "c")),
    )
    private var online = true
    private val originalOnline = QuickAddActivity.isOnline
    private val originalExecutor = QuickAddActivity.previewExecutor

    @Before
    fun setUp() {
        QuickAddActivity.isOnline = { online }
        QuickAddActivity.previewExecutor = Executor { it.run() }
    }

    @After
    fun tearDown() {
        QuickAddActivity.isOnline = originalOnline
        QuickAddActivity.previewExecutor = originalExecutor
    }

    private fun intent(target: String? = null) = Intent(app, QuickAddActivity::class.java).also { if (target != null) it.putExtra(DeepLink.EXTRA_ADD, target) }

    private fun open(target: String? = null): ActivityController<QuickAddActivity> = Robolectric.buildActivity(QuickAddActivity::class.java, intent(target)).setup()

    private val QuickAddActivity.input get() = findViewById<EditText>(R.id.quick_input)
    private val QuickAddActivity.project get() = findViewById<Button>(R.id.quick_project)
    private val QuickAddActivity.today get() = findViewById<ToggleButton>(R.id.quick_today)
    private val QuickAddActivity.tomorrow get() = findViewById<ToggleButton>(R.id.quick_tomorrow)
    private val QuickAddActivity.priority get() = findViewById<Button>(R.id.quick_priority)
    private val QuickAddActivity.add get() = findViewById<Button>(R.id.quick_add)
    private val QuickAddActivity.status get() = findViewById<TextView>(R.id.quick_status)
    private val QuickAddActivity.marked get() = input.text.let { t -> t.getSpans(0, t.length, QuickAddActivity.RecognizedSpan::class.java).sortedBy { t.getSpanStart(it) }.map { t.substring(t.getSpanStart(it), t.getSpanEnd(it)) to it.kind } }
    private val QuickAddActivity.chips get() = findViewById<LinearLayout>(R.id.quick_preview).let { row -> (0 until row.childCount).map { (row.getChildAt(it) as TextView).text.toString() } }

    private fun worker(): SyncWorker =
        TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor()).setInputData(workDataOf(SyncWorker.KEY_PERIODIC to false)).build()

    private fun idle(ms: Long = 0) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    // ---------- openen ----------

    @Test
    fun `opent met de focus in het veld, het toetsenbord omhoog, en Toevoegen pas met tekst`() {
        signIn(withData = data)
        val activity = open().get()
        assertTrue("de focus staat in het veld", activity.input.isFocused)
        val mode = activity.window.attributes.softInputMode
        assertEquals(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE, mode and WindowManager.LayoutParams.SOFT_INPUT_MASK_STATE)
        activity.onWindowFocusChanged(true) // ook dan vraagt het venster het toetsenbord, zonder fout
        assertFalse(activity.add.isEnabled)
        activity.input.setText("   ")
        assertFalse(activity.add.isEnabled)
        activity.input.setText("Brood")
        assertTrue(activity.add.isEnabled)
        assertEquals("Inbox", activity.project.text.toString())
        assertFalse(activity.today.isChecked || activity.tomorrow.isChecked)
        assertEquals("Prioriteit", activity.priority.text.toString())
        assertEquals("Project: Inbox. Tik om te wijzigen.", activity.project.contentDescription)
        assertEquals("Prioriteit: Geen prioriteit. Tik om te wijzigen.", activity.priority.contentDescription)
    }

    @Test
    fun `het project komt uit de widget, Vandaag uit de widget Vandaag, en anders het laatst gekozen`() {
        signIn(withData = data)
        assertEquals("# Werk", open("werk").get().project.text.toString())
        assertEquals("Inbox", open("inbox-project").get().project.text.toString())
        assertEquals("een project dat je alleen leest niet", "Inbox", open("gedeeld").get().project.text.toString())
        assertEquals("een onbekend project niet", "Inbox", open("weg").get().project.text.toString())
        val fromToday = open("today").get()
        assertTrue(fromToday.today.isChecked)
        assertEquals("Inbox", fromToday.project.text.toString())

        // kiezen in de lijst: de Inbox, Werk en Thuis, niet het gedeelde project waar je alleen lezer bent
        val activity = open().get()
        activity.project.performClick()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        val list = dialog.listView
        assertEquals(listOf("Inbox", "Werk", "Thuis"), (0 until list.adapter.count).map { list.adapter.getItem(it).toString() })
        shadowOf(list).performItemClick(2)
        assertEquals("# Thuis", activity.project.text.toString())
        // de volgende keer (tegel, knop-widget): Thuis
        assertEquals("# Thuis", open().get().project.text.toString())
        assertEquals("# Thuis", open("today").get().project.text.toString())
        assertEquals("de widget van een project gaat voor", "# Werk", open("werk").get().project.text.toString())
    }

    @Test
    fun `Vandaag en Morgen sluiten elkaar uit, de prioriteit kies je in een lijstje`() {
        signIn(withData = data)
        val activity = open().get()
        activity.today.performClick()
        assertTrue(activity.today.isChecked)
        activity.tomorrow.performClick()
        assertTrue(activity.tomorrow.isChecked)
        assertFalse(activity.today.isChecked)
        activity.today.performClick()
        assertTrue(activity.today.isChecked)
        assertFalse("en andersom", activity.tomorrow.isChecked)
        activity.today.performClick()
        assertFalse("nog eens tikken zet hem uit", activity.today.isChecked || activity.tomorrow.isChecked)
        activity.priority.performClick()
        val menu = org.robolectric.shadows.ShadowPopupMenu.getLatestPopupMenu()
        assertEquals(listOf("Prioriteit 1 (hoogste)", "Prioriteit 2", "Prioriteit 3", "Geen prioriteit"), (0 until menu.menu.size()).map { menu.menu.getItem(it).title.toString() })
        shadowOf(menu).getOnMenuItemClickListener().onMenuItemClick(menu.menu.getItem(1))
        assertEquals("P2", activity.priority.text.toString())
        assertEquals("Prioriteit: Prioriteit 2. Tik om te wijzigen.", activity.priority.contentDescription)
        activity.setPriority(4)
        assertEquals("Prioriteit", activity.priority.text.toString())
    }

    @Test
    fun `zonder aanmelding opent de app zelf (met Taak toevoegen), en het venster sluit`() {
        val activity = Robolectric.buildActivity(QuickAddActivity::class.java, intent("today")).create().get()
        assertTrue(activity.isFinishing)
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals("today", started.getStringExtra(DeepLink.EXTRA_ADD))
        // en een verlopen aanmelding ook
        signIn(withData = data)
        Session.markExpired(app)
        assertTrue(Robolectric.buildActivity(QuickAddActivity::class.java, intent("werk")).create().get().isFinishing)
    }

    // ---------- toevoegen ----------

    @Test
    fun `toevoegen met verbinding - in de wachtrij met alles erbij, Toegevoegd, en het venster sluit, de verversing verstuurt hem`() {
        server().use { server ->
            signIn(server.origin, data)
            val activity = open("werk").get()
            activity.input.setText("  Tandarts bellen morgen 9 uur @bellen  ")
            activity.tomorrow.performClick()
            activity.setPriority(1)
            activity.add.performClick()
            assertTrue(activity.isFinishing)
            assertEquals("Toegevoegd", ShadowToast.getTextOfLatestToast())
            val item = QuickAddStore.queue(app).single()
            assertEquals("Tandarts bellen morgen 9 uur @bellen", item.text)
            assertEquals("werk", item.projectId)
            assertEquals("tomorrow", item.due)
            assertEquals(1, item.priority)
            assertEquals("2026-11-13T09:00+01:00", item.typedAt)
            assertEquals("Europe/Amsterdam", item.tz)
            assertEquals("user-anna-0001", item.accountId)
            assertTrue(Regex("^tickory-q-[0-9a-f]{24}$").matches(item.uuid))
            assertNull("geen concept meer", QuickAddStore.draft(app, "user-anna-0001"))

            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            val sent = server.requests.single { it.path == ApiClient.QUICK_ADD_PATH }
            assertEquals(item.uuid, Json.parseObject(sent.body)!!.text("uuid"))
            assertTrue(QuickAddStore.queue(app).isEmpty())
        }
    }

    @Test
    fun `toevoegen zonder verbinding - meteen bevestigd, en verstuurd zodra er verbinding is`() {
        online = false
        signIn(FakeServer.closedPortOrigin(), data)
        val activity = open().get()
        activity.input.setText("Melk")
        activity.add.performClick()
        assertEquals("Toegevoegd, wordt verstuurd zodra er verbinding is", ShadowToast.getTextOfLatestToast())
        assertEquals(ListenableWorker.Result.retry(), worker().doWork())
        assertEquals(listOf("Melk"), QuickAddStore.queue(app).map { it.text })
        assertNull("Inbox: geen project-id, de server kiest de Inbox", QuickAddStore.queue(app).single().projectId)
        server().use { server ->
            io.github.wnijhof.tickory.store.Prefs(app).setServer(server.origin, false)
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertTrue(QuickAddStore.queue(app).isEmpty())
        }
    }

    @Test
    fun `Enter voegt toe en sluit het venster - er is geen Nog een toevoegen meer`() {
        signIn(withData = data)
        val first = open().get()
        first.input.setText("Een")
        first.input.onEditorAction(EditorInfo.IME_ACTION_DONE)
        assertTrue(first.isFinishing)

        val second = open("werk").get()
        second.today.performClick()
        second.setPriority(2)
        second.input.setText("Twee")
        second.add.performClick()
        assertTrue("het venster sluit na toevoegen", second.isFinishing)
        assertEquals(listOf("Een", "Twee"), QuickAddStore.queue(app).map { it.text })
        assertEquals(listOf(null, 2), QuickAddStore.queue(app).map { it.priority })
        assertEquals(listOf(null, "today"), QuickAddStore.queue(app).map { it.due })
        // zonder tekst doet Enter niets
        val third = open().get()
        third.input.onEditorAction(EditorInfo.IME_ACTION_DONE)
        assertFalse(third.isFinishing)
        assertEquals(2, QuickAddStore.queue(app).size)
    }

    /** Plakken zoals het toetsenbord of het menu Plakken het doet: tekst met regeleinden op de plek van de cursor. */
    private fun QuickAddActivity.paste(text: String) {
        input.text.insert(input.selectionStart.coerceAtLeast(0), text)
        idle()
    }

    @Test
    fun `een lijst plakken - de vraag of het losse taken worden, en dan elke regel een taak met het project, de dag en de prioriteit`() {
        online = false
        signIn(FakeServer.closedPortOrigin(), data)
        val activity = open("werk").get()
        activity.today.performClick()
        activity.setPriority(2)
        activity.paste("- Eieren kopen\n- Brood\n\n- Kaas morgen")
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertNotNull("na plakken komt de vraag", dialog)
        assertTrue(dialog.isShowing)
        assertEquals("3 taken toevoegen?", shadowOf(dialog).title.toString())
        assertEquals("Elke regel wordt een eigen taak: Eieren kopen · Brood · Kaas morgen", shadowOf(dialog).message.toString())
        assertEquals("3 taken toevoegen", dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).text.toString())
        assertEquals("geen voorvertoning van de hele lijst als één taak", View.GONE, activity.findViewById<View>(R.id.quick_preview_scroll).visibility)
        dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
        idle()
        assertTrue(activity.isFinishing)
        assertEquals("3 taken toegevoegd, worden verstuurd zodra er verbinding is", ShadowToast.getTextOfLatestToast())
        val queue = QuickAddStore.queue(app)
        assertEquals(listOf("Eieren kopen", "Brood", "Kaas morgen"), queue.map { it.text })
        assertEquals(listOf("werk"), queue.map { it.projectId }.distinct())
        assertEquals(listOf("today"), queue.map { it.due }.distinct())
        assertEquals(listOf(2), queue.map { it.priority }.distinct())
        assertEquals("elk een eigen uuid", 3, queue.map { it.uuid }.toSet().size)
    }

    @Test
    fun `een lijst plakken - Als een taak zet de regels achter elkaar, en een gewone tekst plakken vraagt niets`() {
        signIn(withData = data)
        val activity = open().get()
        activity.paste("Brood")
        assertNull("één regel: geen vraag", ShadowAlertDialog.getLatestAlertDialog())
        activity.input.setText("")
        activity.paste("Bel de\ntandarts")
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick()
        idle()
        assertEquals("Als één taak", dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).text.toString())
        assertEquals("Bel de tandarts", activity.input.text.toString())
        assertFalse(activity.isFinishing)
        activity.add.performClick()
        assertEquals(listOf("Bel de tandarts"), QuickAddStore.queue(app).map { it.text })
    }

    @Test
    fun `een lijst plakken - wegtikken en dan Toevoegen vraagt het opnieuw, en is de wachtrij te vol dan komt er niets bij`() {
        signIn(withData = data)
        val activity = open().get()
        activity.paste("Een\nTwee")
        ShadowAlertDialog.getLatestAlertDialog().dismiss()
        idle()
        assertTrue("de tekst blijft staan", activity.input.text.contains("Twee"))
        ShadowAlertDialog.reset()
        activity.add.performClick()
        val again = ShadowAlertDialog.getLatestAlertDialog()
        assertNotNull("Toevoegen met meer regels vraagt het eerst", again)
        assertTrue(QuickAddStore.queue(app).isEmpty())

        val token = io.github.wnijhof.tickory.store.TokenVault.load(app)!!
        val full = (1 until io.github.wnijhof.tickory.core.QuickAddQueue.MAX_ITEMS).map {
            io.github.wnijhof.tickory.core.QueuedQuickAdd("tickory-q-" + it.toString().padStart(24, '0'), "Taak $it", null, null, null, "2026-11-13T09:00+01:00", "Europe/Amsterdam", "user-anna-0001", io.github.wnijhof.tickory.core.QuickAddQueue.sessionTag(token), 1L)
        }
        assertTrue(QuickAddStore.enqueueAll(app, full))
        again.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
        idle()
        assertFalse(activity.isFinishing)
        assertEquals("Er wachten al te veel taken op verbinding. Open de app.", activity.status.text.toString())
        assertEquals("er kwam niets bij, ook niet de eerste", full.size, QuickAddStore.queue(app).size)
    }

    @Test
    fun `terug of ernaast tikken met tekst - niets toegevoegd, de tekst blijft als concept, en dat zegt het venster`() {
        signIn(withData = data)
        val activity = open().get()
        activity.input.setText("Half getypt")
        activity.onBackPressedDispatcher.onBackPressed()
        assertTrue(activity.isFinishing)
        assertEquals("Niet toegevoegd: je tekst staat er de volgende keer nog", ShadowToast.getTextOfLatestToast())
        assertTrue(QuickAddStore.queue(app).isEmpty())

        val again = open().get()
        assertEquals("Half getypt", again.input.text.toString())
        assertEquals(again.input.text.length, again.input.selectionStart)
        assertEquals("Je tekst van de vorige keer staat er nog", again.status.text.toString())
        again.input.setText("")
        again.findViewById<View>(R.id.quick_root).performClick() // ernaast getikt, nu zonder tekst
        assertTrue(again.isFinishing)
        assertNull(QuickAddStore.draft(app, "user-anna-0001"))
        assertEquals("", open().get().input.text.toString())
    }

    @Test
    fun `naar de achtergrond (thuisknop) - het venster sluit en de tekst blijft, een tik op het vlak zelf sluit niet`() {
        signIn(withData = data)
        val controller = open()
        val activity = controller.get()
        activity.findViewById<View>(R.id.quick_sheet).performClick()
        assertFalse(activity.isFinishing)
        activity.input.setText("Even weg")
        controller.pause().stop()
        assertTrue(activity.isFinishing)
        assertEquals("Even weg", QuickAddStore.draft(app, "user-anna-0001"))
    }

    @Test
    fun `een taak die niet aankwam (zonder meldingen) staat de volgende keer in het venster, met de reden en het project`() {
        signIn(withData = data)
        val item = io.github.wnijhof.tickory.core.QueuedQuickAdd("tickory-q-000000000000000000000009", "Terug van de server", "werk", null, null, "2026-11-13T09:00+01:00", "Europe/Amsterdam", "user-anna-0001", "0123456789abcdef", now)
        QuickAddStore.keepReturned(app, item, "Je kunt dit project alleen lezen.")
        val activity = open().get()
        assertEquals("Terug van de server", activity.input.text.toString())
        assertEquals("Niet toegevoegd: Je kunt dit project alleen lezen. Pas het aan of voeg het opnieuw toe.", activity.status.text.toString())
        assertEquals("# Werk", activity.project.text.toString())
        assertEquals("maar één keer", "", open().get().input.text.toString())
    }

    @Test
    fun `het concept van een andere gebruiker komt niet terug`() {
        signIn(withData = data)
        QuickAddStore.saveDraft(app, "user-bram-0002", "Van Bram")
        assertEquals("", open().get().input.text.toString())
        // en het laatst gekozen project van een ander ook niet
        QuickAddStore.setLastProject(app, "user-bram-0002", "werk")
        assertEquals("Inbox", open().get().project.text.toString())
    }

    @Test
    fun `Openen in de app - de app met de tekst, het project en de dag, zonder tekst gewoon Taak toevoegen`() {
        signIn(withData = data)
        val activity = open("werk").get()
        activity.input.setText("Brood halen")
        activity.tomorrow.performClick()
        activity.setPriority(3)
        activity.findViewById<Button>(R.id.quick_open_app).performClick()
        assertTrue(activity.isFinishing)
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals("Brood halen p3", started.getStringExtra(DeepLink.EXTRA_DRAFT_TEXT))
        assertEquals("werk", started.getStringExtra(DeepLink.EXTRA_DRAFT_PROJECT))
        assertEquals("2026-11-14", started.getStringExtra(DeepLink.EXTRA_DRAFT_DUE))
        assertTrue(QuickAddStore.queue(app).isEmpty())
        assertNull(QuickAddStore.draft(app, "user-anna-0001"))

        val empty = open("today").get()
        empty.findViewById<Button>(R.id.quick_open_app).performClick()
        val plain = shadowOf(empty).nextStartedActivity
        assertFalse(plain.hasExtra(DeepLink.EXTRA_DRAFT_TEXT))
        assertEquals("today", plain.getStringExtra(DeepLink.EXTRA_ADD))
    }

    @Test
    fun `de app zet de tekst uit het venster in Taak toevoegen (share-fragment), ook bij een vreemde waarde veilig`() {
        signIn(withData = data)
        val intent = Intent(app, MainActivity::class.java)
            .putExtra(DeepLink.EXTRA_DRAFT_TEXT, "Brood halen p3")
            .putExtra(DeepLink.EXTRA_DRAFT_PROJECT, "werk")
            .putExtra(DeepLink.EXTRA_DRAFT_DUE, "2026-11-14")
        val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
        val web = activity.findViewById<android.view.ViewGroup>(R.id.web_container).getChildAt(0) as WebView
        val url = shadowOf(web).lastLoadedUrl
        assertTrue(url, url.startsWith("$origin/#share="))
        val json = String(Base64.getUrlDecoder().decode(url.substringAfter("#share=")), Charsets.UTF_8)
        assertEquals("""{"title":"Brood halen p3","text":"","project":"werk","due":"2026-11-14"}""", json)
        val odd = Intent(app, MainActivity::class.java).putExtra(DeepLink.EXTRA_DRAFT_TEXT, "');alert(1)//").putExtra(DeepLink.EXTRA_DRAFT_PROJECT, "a'b")
        val url2 = shadowOf(Robolectric.buildActivity(MainActivity::class.java, odd).setup().get().findViewById<android.view.ViewGroup>(R.id.web_container).getChildAt(0) as WebView).lastLoadedUrl
        assertTrue(url2, Regex("^https://taken\\.voorbeeld\\.nl/#share=[A-Za-z0-9_-]+$").matches(url2))
    }

    // ---------- de voorvertoning ----------

    private fun server(preview: String = PREVIEW): FakeServer = FakeServer { request ->
        when {
            request.path != ApiClient.QUICK_ADD_PATH -> Response(200, syncBody())
            request.body.contains("\"dry_run\":true") -> Response(200, preview)
            else -> Response(200, """{"quick_add":1,"dry_run":false,"repeated":false,"task":{"id":"task-nieuw-00001"},"preview":null}""")
        }
    }

    @Test
    fun `de voorvertoning - even na het typen, alleen met verbinding, als labels onder het veld`() {
        server().use { server ->
            signIn(server.origin, data)
            val activity = open().get()
            activity.input.setText("T")
            activity.input.setText("Ta")
            activity.input.setText("Tandarts bellen morgen 9 uur #Werk @bellen @nieuw p1 {vrijdag} !30m")
            idle(100)
            assertTrue("nog niets: er wordt nog getypt", server.requests.isEmpty())
            idle(500)
            val asked = server.requests.single()
            val body = Json.parseObject(asked.body)!!
            assertEquals(true, body["dry_run"])
            assertEquals("Tandarts bellen morgen 9 uur #Werk @bellen @nieuw p1 {vrijdag} !30m", body.text("text"))
            assertNull("een voorvertoning heeft geen uuid", body["uuid"])
            assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.quick_preview_scroll).visibility)
            assertEquals(listOf("Tandarts bellen", "morgen 09:00", "Deadline vr 20 nov", "#Werk", "@bellen", "@nieuw (nieuw)", "P1", "Herinnering 30 min ervoor"), activity.chips)
            assertEquals("Wordt: Tandarts bellen, morgen 09:00, Deadline vr 20 nov, #Werk, @bellen, @nieuw (nieuw), P1, Herinnering 30 min ervoor", activity.findViewById<View>(R.id.quick_preview).contentDescription)
            // de herkende tekst gemarkeerd in het veld, zoals Todoist (een stuk buiten de tekst valt weg)
            assertEquals(listOf("morgen 9 uur" to "date", "#Werk" to "project", "@bellen" to "label", "@nieuw" to "label", "p1" to "priority", "{vrijdag}" to "deadline", "!30m" to "reminder"), activity.marked)

            // in het project dat je al koos: geen label voor het project
            activity.setProject("werk")
            idle(500)
            assertFalse(activity.chips.contains("#Werk"))
            // leeg: weg
            activity.input.setText("")
            idle(500)
            assertEquals(View.GONE, activity.findViewById<View>(R.id.quick_preview_scroll).visibility)
            // met witruimte vooraan: de server rekent zonder, het veld met
            activity.input.setText("  Tandarts bellen morgen 9 uur #Werk @bellen @nieuw p1 {vrijdag} !30m")
            idle(500)
            assertEquals("morgen 9 uur" to "date", activity.marked.first())
            // zonder verbinding: geen voorvertoning en ook geen markering meer
            online = false
            activity.input.setText("Iets morgen")
            idle(500)
            assertEquals(emptyList<Pair<String, String>>(), activity.marked)
        }
    }

    @Test
    fun `de voorvertoning - zonder verbinding of bij een fout niets, en er gaat niets mis`() {
        server(preview = """{"quick_add":1,"error_code":"FORBIDDEN","error":"nee"}""").use { server ->
            signIn(server.origin, data)
            val activity = open().get()
            activity.input.setText("Iets")
            idle(500)
            assertEquals(1, server.requests.size)
            assertEquals(View.GONE, activity.findViewById<View>(R.id.quick_preview_scroll).visibility)
            online = false
            activity.input.setText("Iets anders")
            idle(500)
            assertEquals("zonder verbinding geen verzoek", 1, server.requests.size)
        }
        // een server die niet antwoordt
        signIn(FakeServer.closedPortOrigin(), data)
        online = true
        val activity = open().get()
        activity.input.setText("Iets")
        idle(500)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.quick_preview_scroll).visibility)
    }

    // ---------- wie het opent, en de beveiliging ----------

    @Test
    fun `de tegel en de plusknoppen van de widgets openen het kleine venster, expliciet en onveranderlijk`() {
        val tile = AddTaskTileService.launchIntent(app)
        assertEquals(ComponentName(app, QuickAddActivity::class.java), tile.component)
        assertTrue(tile.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        for (target in listOf("today", "werk", null)) {
            val pi = WidgetIntents.addTask(app, target)
            val saved = shadowOf(pi).savedIntent
            assertEquals(QuickAddActivity::class.java.name, saved.component!!.className)
            assertEquals(target ?: "", saved.getStringExtra(DeepLink.EXTRA_ADD))
            assertTrue(shadowOf(pi).flags and android.app.PendingIntent.FLAG_IMMUTABLE != 0)
        }
    }

    @Test
    fun `manifest - niet exporteerbaar, een eigen taak buiten de recente apps, doorzichtig thema, toetsenbord omhoog`() {
        val info = app.packageManager.getActivityInfo(ComponentName(app, QuickAddActivity::class.java), 0)
        assertFalse("alleen de app zelf kan het openen", info.exported)
        assertEquals("", info.taskAffinity ?: "")
        assertTrue(info.flags and ActivityInfo.FLAG_EXCLUDE_FROM_RECENTS != 0)
        assertEquals(R.style.Theme_Tickory_QuickAdd, info.themeResource)
        assertEquals(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE, info.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_STATE)
        val attrs = app.obtainStyledAttributes(R.style.Theme_Tickory_QuickAdd, intArrayOf(android.R.attr.windowIsTranslucent))
        assertTrue(attrs.getBoolean(0, false))
        attrs.recycle()
    }

    @Test
    fun `TalkBack en 48 dp - elk tikvlak is groot genoeg en heeft een tekst`() {
        signIn(withData = data)
        val activity = open().get()
        for (id in listOf(R.id.quick_input, R.id.quick_project, R.id.quick_today, R.id.quick_tomorrow, R.id.quick_priority, R.id.quick_open_app, R.id.quick_add)) {
            val v = activity.findViewById<View>(id)
            val minPx = (48 * activity.resources.displayMetrics.density).toInt()
            assertTrue("${activity.resources.getResourceEntryName(id)} is minstens 48 dp hoog", v.minimumHeight >= minPx)
            val label = v.contentDescription ?: (v as? TextView)?.let { it.text?.takeIf(CharSequence::isNotBlank) ?: it.hint }
            assertNotNull(activity.resources.getResourceEntryName(id), label)
        }
    }

    @Test
    fun `Engels - de teksten in het venster`() {
        val en = app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply { setLocale(java.util.Locale.ENGLISH) })
        assertEquals("Add", en.getString(R.string.quick_add))
        assertEquals("Today", en.getString(R.string.quick_today))
        assertEquals("Tomorrow", en.getString(R.string.quick_tomorrow))
        assertEquals("Open in the app", en.getString(R.string.quick_open_app))
        assertEquals("Added; it will be sent as soon as there is a connection", en.getString(R.string.quick_added_offline))
        assertEquals("1 day before", en.resources.getQuantityString(R.plurals.quick_reminder_days, 1, 1))
    }

    private companion object {
        const val PREVIEW = """{"quick_add":1,"dry_run":true,"repeated":false,"task":null,"preview":{"content":"Tandarts bellen","due":{"date":"2026-11-14T09:00","string":"morgen om 9 uur","lang":"nl"},
            "deadline":"2026-11-20","duration":null,"project":{"id":"werk","name":"Werk","inbox":false},"section":null,
            "labels":[{"name":"bellen","new":false},{"name":"nieuw","new":true}],"priority":1,"reminders":[{"type":"relative","minute_offset":30}],"auto_reminder":false,
            "spans":[{"start":16,"end":28,"kind":"date"},{"start":29,"end":34,"kind":"project"},{"start":35,"end":42,"kind":"label"},{"start":43,"end":49,"kind":"label"},
            {"start":50,"end":52,"kind":"priority"},{"start":53,"end":62,"kind":"deadline"},{"start":63,"end":67,"kind":"reminder"},{"start":60,"end":999,"kind":"date"}]}}"""
    }
}
