package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetAccent
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetTheme
import io.github.wnijhof.tickory.store.WidgetConfigStore

/**
 * De instellingen van de widgets Productiviteit en Snelle acties, zoals in Todoist: het thema (de kleur), de weergave (zoals de telefoon,
 * licht of donker) en de ondoorzichtigheid; bij Productiviteit ook "Tikken op de widget" (het scherm Productiviteit of de startpagina).
 * Opent bij het plaatsen en later opnieuw via vasthouden op de widget. Alleen "Opslaan" bewaart; sluiten zonder opslaan plaatst de widget niet.
 * Dit scherm is voor Android bereikbaar (exported), dus het controleert dat het widget-id echt van een van deze twee widgets is.
 */
class WidgetStyleActivity : ComponentActivity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private lateinit var theme: RadioGroup
    private lateinit var opacity: SeekBar
    private lateinit var opacityValue: TextView
    private lateinit var accent: Spinner
    private lateinit var tap: Spinner

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (!isOwnWidget(this, appWidgetId)) {
            finish()
            return
        }
        setContentView(R.layout.activity_widget_style)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        theme = findViewById(R.id.style_theme)
        opacity = findViewById(R.id.style_opacity)
        opacityValue = findViewById(R.id.style_opacity_value)
        accent = findViewById(R.id.style_accent)
        tap = findViewById(R.id.style_tap)

        val current = WidgetConfigStore.options(this, appWidgetId)
        theme.check(
            when (current.theme) {
                WidgetTheme.SYSTEM -> R.id.style_theme_system
                WidgetTheme.LIGHT -> R.id.style_theme_light
                WidgetTheme.DARK -> R.id.style_theme_dark
            },
        )
        accent.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, WidgetAccent.entries.map { WidgetPalette.label(this, it) })
        accent.setSelection(current.accent.ordinal)
        opacity.progress = current.opacity
        opacityValue.text = getString(R.string.widget_opacity_value, current.opacity)
        opacity.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                opacityValue.text = getString(R.string.widget_opacity_value, progress)
            }
            override fun onStartTrackingTouch(bar: SeekBar) {}
            override fun onStopTrackingTouch(bar: SeekBar) {}
        })
        // "Tikken op de widget" bestaat alleen bij Productiviteit
        val productivity = isProductivity(this, appWidgetId)
        findViewById<View>(R.id.style_tap_label).visibility = if (productivity) View.VISIBLE else View.GONE
        tap.visibility = if (productivity) View.VISIBLE else View.GONE
        tap.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf(getString(R.string.widget_tap_productivity), getString(R.string.widget_tap_home)))
        tap.setSelection(if (WidgetConfigStore.tapAction(this, appWidgetId) == WidgetConfigStore.TAP_HOME) 1 else 0)
        tap.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {}
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        findViewById<Button>(R.id.style_save).setOnClickListener { save(productivity) }
    }

    private fun save(productivity: Boolean) {
        val current = WidgetConfigStore.options(this, appWidgetId)
        WidgetConfigStore.setOptions(
            this, appWidgetId,
            current.copy(
                theme = when (theme.checkedRadioButtonId) {
                    R.id.style_theme_light -> WidgetTheme.LIGHT
                    R.id.style_theme_dark -> WidgetTheme.DARK
                    else -> WidgetTheme.SYSTEM
                },
                accent = WidgetAccent.entries[accent.selectedItemPosition.coerceIn(0, WidgetAccent.entries.size - 1)],
                opacity = opacity.progress,
            ),
        )
        if (productivity) WidgetConfigStore.setTapAction(this, appWidgetId, if (tap.selectedItemPosition == 1) WidgetConfigStore.TAP_HOME else WidgetConfigStore.TAP_PRODUCTIVITY)
        WidgetUpdater.updateAll(this)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }

    companion object {
        private fun on(context: Context, appWidgetId: Int, cls: Class<*>): Boolean {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, cls)
            return manager.getAppWidgetInfo(appWidgetId)?.provider == component || appWidgetId in manager.getAppWidgetIds(component)
        }

        fun isProductivity(context: Context, appWidgetId: Int): Boolean = on(context, appWidgetId, ProductivityWidgetProvider::class.java)

        /** Is dit het id van een bestaande widget Productiviteit of Snelle acties van deze app? */
        fun isOwnWidget(context: Context, appWidgetId: Int): Boolean {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return false
            return isProductivity(context, appWidgetId) || on(context, appWidgetId, QuickActionsWidgetProvider::class.java)
        }
    }
}
