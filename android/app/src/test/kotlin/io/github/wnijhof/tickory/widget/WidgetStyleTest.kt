package io.github.wnijhof.tickory.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.view.View
import android.widget.RadioButton
import android.widget.SeekBar
import android.widget.Spinner
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetAccent
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetTheme
import io.github.wnijhof.tickory.store.WidgetConfigStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/** De instellingen van Productiviteit en Snelle acties (thema, weergave, ondoorzichtigheid, tikactie) en hun uiterlijk. */
class WidgetStyleTest : WidgetTestBase() {
    private val manager: AppWidgetManager get() = AppWidgetManager.getInstance(app)

    private fun place(provider: Class<out android.appwidget.AppWidgetProvider>, layout: Int): Int = shadowOf(manager).createWidget(provider, layout)

    private fun view(id: Int): View = shadowOf(manager).getViewFor(id)

    private fun styleIntent(id: Int) = Intent(app, WidgetStyleActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)

    @Test
    fun `Productiviteit - thema, weergave en ondoorzichtigheid worden bewaard en de widget wordt opnieuw getekend`() {
        signIn(withData = snapshot())
        val id = place(ProductivityWidgetProvider::class.java, R.layout.widget_productivity)
        val other = place(ProductivityWidgetProvider::class.java, R.layout.widget_productivity)
        val activity = Robolectric.buildActivity(WidgetStyleActivity::class.java, styleIntent(id)).setup().get()
        assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
        assertEquals("Tikken op de widget bestaat bij Productiviteit", View.VISIBLE, activity.findViewById<View>(R.id.style_tap).visibility)

        activity.findViewById<Spinner>(R.id.style_accent).setSelection(WidgetAccent.RASPBERRY.ordinal)
        activity.findViewById<RadioButton>(R.id.style_theme_dark).isChecked = true
        activity.findViewById<SeekBar>(R.id.style_opacity).progress = 40
        activity.findViewById<Spinner>(R.id.style_tap).setSelection(1) // de startpagina
        activity.findViewById<View>(R.id.style_save).performClick()

        assertTrue(activity.isFinishing)
        assertEquals(Activity.RESULT_OK, shadowOf(activity).resultCode)
        assertEquals(WidgetOptions(theme = WidgetTheme.DARK, opacity = 40, accent = WidgetAccent.RASPBERRY), WidgetConfigStore.options(app, id))
        assertEquals(WidgetOptions(), WidgetConfigStore.options(app, other))
        assertEquals(WidgetConfigStore.TAP_HOME, WidgetConfigStore.tapAction(app, id))
        assertEquals(WidgetConfigStore.TAP_PRODUCTIVITY, WidgetConfigStore.tapAction(app, other))

        // een tik opent nu de startpagina, niet het scherm Productiviteit
        view(id).findViewById<View>(R.id.prod_root).performClick()
        val started = shadowOf(app).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals(null, started.getStringExtra(DeepLink.EXTRA_VIEW))
    }

    @Test
    fun `Snelle acties - geen tikactie, wel thema, en de instellingen verdwijnen met de widget`() {
        val id = place(QuickActionsWidgetProvider::class.java, R.layout.widget_quick_actions)
        val activity = Robolectric.buildActivity(WidgetStyleActivity::class.java, styleIntent(id)).setup().get()
        assertEquals(View.GONE, activity.findViewById<View>(R.id.style_tap).visibility)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.style_tap_label).visibility)
        activity.findViewById<Spinner>(R.id.style_accent).setSelection(WidgetAccent.GOLD.ordinal)
        activity.findViewById<View>(R.id.style_save).performClick()
        assertEquals(WidgetAccent.GOLD, WidgetConfigStore.options(app, id).accent)
        WidgetConfigStore.remove(app, intArrayOf(id))
        assertEquals(WidgetOptions(), WidgetConfigStore.options(app, id))
    }

    @Test
    fun `een vast thema geeft de widget de kleuren van dat thema`() {
        val id = place(QuickActionsWidgetProvider::class.java, R.layout.widget_quick_actions)
        WidgetConfigStore.setOptions(app, id, WidgetOptions(theme = WidgetTheme.DARK, accent = WidgetAccent.BLUEBERRY))
        val colors = WidgetPalette.resolve(app, WidgetConfigStore.options(app, id))
        assertEquals(0xFF1F1F1F.toInt(), colors.background)
        assertEquals(0xFF2A7BBD.toInt(), colors.accent)
        val light = WidgetPalette.resolve(app, WidgetOptions(theme = WidgetTheme.LIGHT, accent = WidgetAccent.BLUEBERRY))
        assertEquals(0xFFFFFFFF.toInt(), light.background)
        assertEquals(0xFF297ABC.toInt(), light.accent)
        // Dynamische kleur komt uit de resources
        assertEquals(app.getColor(R.color.widget_accent), WidgetPalette.resolve(app, WidgetOptions(theme = WidgetTheme.LIGHT)).accent)
    }

    @Test
    fun `het scherm weigert een onbekend of vreemd widget-id`() {
        val list = place(TodayWidgetProvider::class.java, R.layout.widget_list)
        for (intent in listOf(styleIntent(9999), styleIntent(list), Intent(app, WidgetStyleActivity::class.java))) {
            val activity = Robolectric.buildActivity(WidgetStyleActivity::class.java, intent).setup().get()
            assertTrue(activity.isFinishing)
            assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
        }
        assertFalse(WidgetStyleActivity.isOwnWidget(app, list))
    }

    @Test
    fun `de titel van een lijstwidget opent alleen de keuze van het overzicht en bewaart meteen`() {
        signIn(withData = snapshot())
        val id = place(TodayWidgetProvider::class.java, R.layout.widget_list)
        val intent = Intent(app, WidgetConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).putExtra(WidgetConfigActivity.EXTRA_CHOOSE_ONLY, true)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, intent).setup().get()
        assertEquals("geen Opslaan-knop", View.GONE, activity.findViewById<View>(R.id.config_save).visibility)
        val list = activity.findViewById<android.widget.ListView>(R.id.config_list)
        list.performItemClick(null, 2 + list.headerViewsCount, 2) // Inbox
        assertTrue(activity.isFinishing)
        assertEquals("inbox", WidgetConfigStore.get(app, id))
    }
}
