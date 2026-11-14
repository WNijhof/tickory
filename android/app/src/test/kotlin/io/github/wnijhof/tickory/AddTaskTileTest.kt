package io.github.wnijhof.tickory

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import io.github.wnijhof.tickory.core.DeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** De tegel "Taak toevoegen" in de snelle instellingen: wat hij start, wie hem mag binden, en de teksten. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AddTaskTileTest {
    private val app: android.app.Application = ApplicationProvider.getApplicationContext()

    @Test
    fun `de tegel start de app op Taak toevoegen, expliciet en als nieuwe taak`() {
        val intent = AddTaskTileService.launchIntent(app)
        assertEquals(ComponentName(app, MainActivity::class.java), intent.component)
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue("MainActivity moet er een 'add' in herkennen", intent.hasExtra(DeepLink.EXTRA_ADD))
        assertEquals("add", DeepLink.add(intent.getStringExtra(DeepLink.EXTRA_ADD)))
        assertNull("geen taak-id: het is Taak toevoegen, niet een taak openen", intent.getStringExtra(io.github.wnijhof.tickory.reminders.Notifications.EXTRA_TASK_ID))
    }

    @Test
    fun `manifest - alleen het systeem mag de tegel binden`() {
        val info = app.packageManager.getServiceInfo(ComponentName(app, AddTaskTileService::class.java), PackageManager.GET_META_DATA)
        assertEquals("android.permission.BIND_QUICK_SETTINGS_TILE", info.permission)
        assertTrue("Android moet de tegel kunnen vinden", info.exported)
        val filter = Intent("android.service.quicksettings.action.QS_TILE").setPackage(app.packageName)
        assertTrue(app.packageManager.queryIntentServices(filter, 0).any { it.serviceInfo.name == AddTaskTileService::class.java.name })
    }

    @Test
    fun `de tegel heeft een naam en een pictogram, in beide talen`() {
        val info = app.packageManager.getServiceInfo(ComponentName(app, AddTaskTileService::class.java), 0)
        assertNotEquals(0, info.icon)
        assertEquals(R.string.tile_add_label, info.labelRes)
        fun inLocale(tag: String) = app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply { setLocale(java.util.Locale.forLanguageTag(tag)) })
        assertEquals("Taak toevoegen", inLocale("nl").getString(R.string.tile_add_label))
        assertEquals("Add task", inLocale("en").getString(R.string.tile_add_label))
        assertNotNull(app.getDrawable(R.drawable.ic_tile_add))
    }
}
