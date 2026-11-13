package io.github.wnijhof.tickory.widget

import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Wat de widgets op het toestel bewaren, voor wie, en wanneer het weggaat. */
class WidgetStoreTest : WidgetTestBase() {
    private val anna = snapshot(listOf(task("t1", "2026-11-13", content = "Geheime taak van Anna")), account = "user-anna-0001")
    private val bob = snapshot(listOf(task("t9", "2026-11-13", content = "Taak van Bob")), account = "user-bob-0002")

    private fun queued(task: String, account: String = "user-anna-0001") = QueuedComplete(task, "tickory-w-$task-00000000", null, account, 1L)

    private fun files(): List<String> = File(app.filesDir, "widgets").list()?.sorted() ?: emptyList()

    @Test
    fun `gegevens bewaren en teruglezen, ook na een herstart (van schijf)`() {
        assertNull(WidgetStore.snapshot(app))
        assertTrue(WidgetStore.accept(app, anna))
        assertEquals(anna, WidgetStore.snapshot(app))
        assertEquals(anna, WidgetStore.visibleSnapshot(app))
        assertFalse("dezelfde gegevens nog eens: niets veranderd", WidgetStore.accept(app, anna))
        // alles staat in bestanden in de privé-opslag; geen halve bestanden achtergebleven
        assertEquals(listOf("widget-cache.json"), files())
        assertTrue(File(app.filesDir, "widgets/widget-cache.json").readText().contains("Geheime taak van Anna"))
    }

    @Test
    fun `een kapot bestand geeft geen gegevens in plaats van een fout`() {
        WidgetStore.accept(app, anna)
        WidgetStore.enqueue(app, queued("t1"))
        File(app.filesDir, "widgets/widget-cache.json").writeText("{ kapot")
        File(app.filesDir, "widgets/widget-queue.json").writeText("???")
        assertNull(WidgetStore.snapshot(app))
        assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
        // en daarna werkt alles gewoon weer
        assertTrue(WidgetStore.accept(app, anna))
        assertTrue(WidgetStore.enqueue(app, queued("t1")))
    }

    @Test
    fun `de wachtrij overleeft een herstart en dubbel zetten is een actie`() {
        assertTrue(WidgetStore.enqueue(app, queued("t1")))
        assertFalse(WidgetStore.enqueue(app, queued("t1").copy(uuid = "tickory-w-ander-00000000")))
        assertTrue(WidgetStore.enqueue(app, queued("t2")))
        assertEquals(listOf("t1", "t2"), WidgetStore.queue(app).map { it.taskId })
        assertEquals("tickory-w-t1-00000000", WidgetStore.queue(app).first().uuid)
        WidgetStore.updateQueue(app) { it.filter { item -> item.taskId != "t1" } }
        assertEquals(listOf("t2"), WidgetStore.queue(app).map { it.taskId })
        assertEquals(listOf("widget-queue.json"), files())
    }

    @Test
    fun `een andere gebruiker - de gegevens worden vervangen en de wachtrij van de vorige is weg`() {
        WidgetStore.accept(app, anna)
        WidgetStore.enqueue(app, queued("t1", "user-anna-0001"))
        WidgetStore.accept(app, bob)
        assertEquals(bob, WidgetStore.snapshot(app))
        assertEquals("wat Anna afvinkte mag nooit onder Bob worden verstuurd", emptyList<QueuedComplete>(), WidgetStore.queue(app))
    }

    @Test
    fun `dezelfde gebruiker - de wachtrij blijft`() {
        WidgetStore.accept(app, anna)
        WidgetStore.enqueue(app, queued("t1"))
        WidgetStore.accept(app, anna.copy(tasks = emptyList()))
        assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })
    }

    @Test
    fun `ongecontroleerd - na een nieuwe aanmelding tonen de widgets niets tot de eerste verversing`() {
        WidgetStore.accept(app, anna)
        WidgetStore.markUnverified(app)
        assertTrue(WidgetStore.isUnverified(app))
        assertNull("niets tonen", WidgetStore.visibleSnapshot(app))
        assertNotNull("wel bewaard, voor als het dezelfde gebruiker blijkt", WidgetStore.snapshot(app))
        WidgetStore.accept(app, anna)
        assertFalse(WidgetStore.isUnverified(app))
        assertEquals(anna, WidgetStore.visibleSnapshot(app))
    }

    @Test
    fun `ongecontroleerd markeren zonder gegevens doet niets`() {
        WidgetStore.markUnverified(app)
        assertFalse(WidgetStore.isUnverified(app))
    }

    @Test
    fun `afmelden - alles weg, ook de wachtrij`() {
        WidgetStore.accept(app, anna)
        WidgetStore.enqueue(app, queued("t1"))
        WidgetStore.markUnverified(app)
        WidgetStore.clearAll(app)
        assertNull(WidgetStore.snapshot(app))
        assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
        assertFalse(WidgetStore.isUnverified(app))
        assertEquals(emptyList<String>(), files())
    }

    // ---------- via de aanmelding van de app ----------

    @Test
    fun `Session - afmelden leegt de gegevens en de widgets vragen om in te loggen`() {
        signIn(withData = anna)
        WidgetStore.enqueue(app, queued("t1"))
        assertTrue(WidgetModel.state(app, WidgetSource.Today) is WidgetModel.State.Ready)

        Session.signOut(app)

        assertNull(WidgetStore.snapshot(app))
        assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
        assertEquals(WidgetModel.State.SignedOut, WidgetModel.state(app, WidgetSource.Today))
    }

    @Test
    fun `Session - een leeg token via de brug meldt af, ook de gegevens`() {
        signIn(withData = anna)
        Session.set(app, "")
        assertNull(WidgetStore.snapshot(app))
        assertNull(Prefs(app).encryptedToken)
    }

    @Test
    fun `Session - hetzelfde token opnieuw doorgeven verbergt niets`() {
        signIn(withData = anna)
        Session.set(app, token)
        Session.set(app, token)
        assertFalse(WidgetStore.isUnverified(app))
        assertTrue(WidgetModel.state(app, WidgetSource.Today) is WidgetModel.State.Ready)
    }

    @Test
    fun `Session - een ander token verbergt de gegevens van de vorige gebruiker direct`() {
        signIn(withData = anna)
        Session.set(app, "tky_andere-gebruiker_0123456789-ABCDEF")
        assertEquals("zolang niet vaststaat van wie de gegevens zijn: niets", WidgetModel.State.Loading, WidgetModel.state(app, WidgetSource.Today))
        assertNull(WidgetStore.visibleSnapshot(app))
    }

    @Test
    fun `Session - het kiezen van een bron per widget wordt onthouden en met de widget weer vergeten`() {
        WidgetConfigStore.set(app, 7, WidgetSource.Project("werk-1").key)
        assertEquals("project:werk-1", WidgetConfigStore.get(app, 7))
        assertNull(WidgetConfigStore.get(app, 8))
        WidgetConfigStore.remove(app, intArrayOf(7))
        assertNull(WidgetConfigStore.get(app, 7))
    }

    @Test
    fun `de widgets tonen niets zonder aanmelding en bij een verlopen aanmelding`() {
        // geen server
        assertEquals(WidgetModel.State.SignedOut, WidgetModel.state(app, WidgetSource.Today))
        // een server maar geen token
        Prefs(app).setServer(origin, false)
        assertEquals(WidgetModel.State.SignedOut, WidgetModel.state(app, WidgetSource.Today))
        // aangemeld met gegevens
        signIn(withData = anna)
        assertTrue(WidgetModel.state(app, WidgetSource.Today) is WidgetModel.State.Ready)
        // de server zegt 401
        Session.markExpired(app)
        assertEquals(WidgetModel.State.Expired, WidgetModel.state(app, WidgetSource.Today))
        // opnieuw ingelogd (hetzelfde token, sessie niet meer verlopen)
        Session.set(app, token)
        assertTrue(WidgetModel.state(app, WidgetSource.Today) is WidgetModel.State.Ready)
    }

    @Test
    fun `aangemeld maar nog geen gegevens - laden`() {
        signIn()
        assertEquals(WidgetModel.State.Loading, WidgetModel.state(app, WidgetSource.Today))
    }
}
