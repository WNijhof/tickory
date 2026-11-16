package io.github.wnijhof.tickory

import android.content.ComponentName
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.quickadd.QuickAddActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** De snelkoppelingen onder het app-icoon: wat ze openen, hun namen, en dat alleen vaste keuzes doorkomen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppShortcutsTest {
    private val app: android.app.Application = ApplicationProvider.getApplicationContext()

    @Test
    @Config(sdk = [34], qualifiers = "nl")
    fun `drie snelkoppelingen - Taak toevoegen in het kleine venster, Vandaag en Nieuwe notitie in de app`() {
        val list = AppShortcuts.build(app)
        assertEquals(listOf(AppShortcuts.ADD, AppShortcuts.TODAY, AppShortcuts.NOTE), list.map { it.id })
        assertEquals(listOf("Nieuwe taak", "Vandaag", "Notitie"), list.map { it.shortLabel.toString() })
        assertEquals(listOf("Taak toevoegen", "Vandaag openen", "Nieuwe notitie"), list.map { it.longLabel.toString() })
        val add = list[0].intent
        assertEquals(ComponentName(app, QuickAddActivity::class.java), add.component)
        assertEquals("add", DeepLink.add(add.getStringExtra(DeepLink.EXTRA_ADD)))
        for ((shortcut, fragment) in list.drop(1).zip(listOf("view=today", "note=new"))) {
            assertEquals(ComponentName(app, MainActivity::class.java), shortcut.intent.component)
            assertEquals("geen VIEW: die hoort bij de terugkeer van de inlogdienst", AppShortcuts.ACTION, shortcut.intent.action)
            assertEquals(fragment, DeepLink.view(shortcut.intent.getStringExtra(DeepLink.EXTRA_VIEW)))
        }
    }

    @Test
    fun `zetten werkt, en opnieuw zetten geeft geen dubbele`() {
        AppShortcuts.publish(app)
        AppShortcuts.publish(app)
        val set = ShortcutManagerCompat.getDynamicShortcuts(app).sortedBy { it.rank }
        assertEquals(listOf(AppShortcuts.ADD, AppShortcuts.TODAY, AppShortcuts.NOTE), set.map { it.id })
        assertEquals("in het Engels als het toestel Engels is", listOf("New task", "Today", "Note"), set.map { it.shortLabel.toString() })
    }

    @Test
    fun `alleen vaste keuzes worden een fragment`() {
        assertEquals("view=upcoming", DeepLink.view(DeepLink.VIEW_UPCOMING))
        assertEquals("view=inbox", DeepLink.view("inbox"))
        assertEquals("view=notes", DeepLink.view("notes"))
        for (bad in listOf(null, "", "task=abc", "today;alert(1)", "TODAY")) assertNull(bad, DeepLink.view(bad))
    }
}
