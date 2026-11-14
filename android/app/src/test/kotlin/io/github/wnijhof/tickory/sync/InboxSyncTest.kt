package io.github.wnijhof.tickory.sync

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.inbox.AppVisibility
import io.github.wnijhof.tickory.inbox.InboxNotifier
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.InboxStore
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator

/**
 * Meldingen bij samenwerken op een nagebootst Android (Robolectric): de verversing haalt ze op, nieuwe ongelezen komen als melding
 * (in de taal van het toestel, met "Openen"), gelezen meldingen verdwijnen, niets dubbel, en afmelden haalt alles weg.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class InboxSyncTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val manager get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val originalExecutor: Executor = Background.executor
    private val token = "tky_test-token_0123456789-ABCDEFGHIJ"
    private val now = Instant.parse("2030-06-14T08:00:00Z").toEpochMilli()
    private fun at(minutesAgo: Long) = Instant.ofEpochMilli(now - minutesAgo * 60_000).toString()

    private fun note(id: String, kind: String, read: Boolean = false, comment: String? = null) =
        """{"id":"$id","kind":"$kind","actor_id":"user-bram","task_id":"task-0001","project_id":null,"comment_id":${comment?.let { "\"$it\"" }},"is_read":$read,"owner_id":"user-anna","created_at":"${at(5)}","is_deleted":false}"""

    private fun body(vararg notes: String, push: String = "null") = """{"sync_token":"9","sync_status":{},"me":{"id":"user-anna","name":"Anna"},
        "users":[{"id":"user-anna","name":"Anna"},{"id":"user-bram","name":"Bram"}],
        "tasks":[{"id":"task-0001","project_id":"proj-0001","content":"Tegels kiezen","due":null,"checked":false,"is_deleted":false}],
        "projects":[{"id":"proj-0001","name":"Verbouwing","is_deleted":false}],
        "comments":[{"id":"comm-0001","content":"@Anna, welke kleur?","is_deleted":false}],
        "settings":[{"id":"settings-user-anna","owner_id":"user-anna","notify_push":$push}],
        "reminders":[],"places":[],"sections":[],"labels":[],
        "notifications":[${notes.joinToString(",")}]}"""

    @Before
    fun setUp() {
        AppClock.now = { now }
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        AppVisibility.visible = false
    }

    @After
    fun tearDown() {
        AppClock.now = { System.currentTimeMillis() }
        Background.executor = originalExecutor
        AppVisibility.visible = false
    }

    private fun refresh(server: FakeServer) {
        Prefs(app).setServer(server.origin, false)
        Session.set(app, token)
        val worker = TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor()).build()
        assertEquals(ListenableWorker.Result.success(), worker.doWork())
    }

    private fun shown(): List<Notification> = manager.allNotifications.filter { it.channelId == InboxNotifier.CHANNEL_ID }

    @Test
    fun `de eerste verversing toont niets, daarna komt een nieuwe melding een keer in beeld en verdwijnt als hij gelezen is`() {
        var response = body(note("n-old-0001", "assigned"))
        FakeServer { Response(200, response) }.use { server ->
            refresh(server)
            assertEquals("geen stapel oude meldingen na het inloggen", 0, shown().size)

            response = body(note("n-old-0001", "assigned"), note("n-new-0001", "mention", comment = "comm-0001"))
            refresh(server)
            val n = shown().single()
            assertEquals("Bram noemde je in een opmerking", n.extras.getString(Notification.EXTRA_TITLE))
            assertEquals("Tegels kiezen · Verbouwing", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
            assertEquals("Tegels kiezen · Verbouwing\n@Anna, welke kleur?", n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
            assertEquals(listOf("Openen"), n.actions.map { it.title.toString() })
            val open = shadowOf(n.contentIntent).savedIntent
            assertEquals(MainActivity::class.java.name, open.component?.className)
            assertEquals("n-new-0001", open.getStringExtra(InboxNotifier.EXTRA_NOTIFICATION_ID))

            refresh(server)
            assertEquals("niet dubbel", 1, shown().size)

            response = body(note("n-old-0001", "assigned"), note("n-new-0001", "mention", read = true, comment = "comm-0001"))
            refresh(server)
            assertEquals("in de app gelezen: de melding gaat weg", 0, shown().size)
        }
    }

    @Test
    fun `een soort die uit staat, of de app die open staat, geeft geen melding, afmelden wist alles`() {
        var response = body()
        FakeServer { Response(200, response) }.use { server ->
            refresh(server)
            response = body(note("n-done-0001", "completed"), note("n-assi-0001", "assigned"), push = """{"assigned":false}""")
            refresh(server)
            assertEquals("afgevinkt staat standaard uit, toewijzen hier ook", 0, shown().size)

            AppVisibility.visible = true
            response = body(note("n-done-0001", "completed"), note("n-assi-0001", "assigned"), note("n-ment-0001", "mention"))
            refresh(server)
            assertEquals("de app staat open", 0, shown().size)
            AppVisibility.visible = false
            response = body(note("n-ment-0001", "mention"), note("n-shar-0001", "shared"))
            refresh(server)
            assertEquals(1, shown().size)
            assertTrue(InboxStore.load(app)!!.shown.contains("n-shar-0001"))

            Session.signOut(app)
            assertEquals(0, shown().size)
            assertNull(InboxStore.load(app))
        }
    }

    @Test
    fun `een server zonder meldingen verandert niets`() {
        FakeServer { request ->
            if (request.body.contains("notifications")) Response(400, """{"error_code":"INVALID_REQUEST"}""")
            else Response(200, """{"sync_token":"9","me":{"id":"user-anna"},"tasks":[],"reminders":[],"projects":[],"places":[]}""")
        }.use { server ->
            refresh(server)
            assertNull(InboxStore.load(app))
            assertEquals(0, shown().size)
        }
    }
}
