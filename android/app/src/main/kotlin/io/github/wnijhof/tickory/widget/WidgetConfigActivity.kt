package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetAccent
import io.github.wnijhof.tickory.core.WidgetChoice
import io.github.wnijhof.tickory.core.WidgetFont
import io.github.wnijhof.tickory.core.WidgetPreset
import io.github.wnijhof.tickory.core.WidgetChoices
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.core.WidgetTheme
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session

/**
 * De instellingen van een lijstwidget (Vandaag, Binnenkort, Project of lijst), zoals in de widget van Todoist: het thema (zoals de telefoon,
 * licht of donker), de compacte weergave (de datum rechts op dezelfde regel) en de doorzichtigheid van de achtergrond. Bij de widget
 * "Project of lijst" kies je hier ook wat hij toont: Vandaag, Binnenkort, de Inbox, een project of een filter (zie [WidgetChoices]).
 * Het scherm opent bij het plaatsen en later opnieuw via vasthouden op de widget (Android 9 en nieuwer). Pas "Opslaan" bewaart en tekent
 * de widget opnieuw; sluiten zonder opslaan plaatst de widget niet (en laat een bestaande widget zoals hij was).
 *
 * Zonder aanmelding zijn de vaste keuzes er wel; de projecten komen erbij zodra je bent ingelogd.
 *
 * Dit scherm moet voor Android bereikbaar zijn (exported), dus het controleert dat het widget-id echt van een lijstwidget van deze app is
 * voordat het iets bewaart.
 */
class WidgetConfigActivity : ComponentActivity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var choices: List<WidgetChoice> = emptyList()

    /** De gekozen bron (alleen bij Project of lijst); null bij Vandaag en Binnenkort, die hun eigen vaste bron hebben. */
    private var selected: String? = null
    private var adapter: ChoiceAdapter? = null

    /** De opties boven de lijst (als kop van de lijst); ook voor de tests. */
    internal lateinit var optionsView: View
    private lateinit var themeGroup: RadioGroup
    private lateinit var compact: Switch
    private lateinit var opacity: SeekBar
    private lateinit var opacityValue: TextView
    private lateinit var accentSpinner: Spinner
    private lateinit var fontSpinner: Spinner
    private lateinit var presetSpinner: Spinner

    /** Tijdens het invullen van de keuzes door een voorgestelde stijl reageren de keuzelijsten niet op zichzelf. */
    private var applyingPreset = false
    private lateinit var previewBox: android.widget.FrameLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED) // sluit je dit scherm zonder op te slaan, dan wordt de widget niet geplaatst
        appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (!isOwnWidget(this, appWidgetId)) {
            finish()
            return
        }
        setContentView(R.layout.activity_widget_config)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        // zoals in Todoist kiest elke lijstwidget zelf wat hij toont (Inbox, Vandaag, Aankomend, een project, een filter)
        val pickSource = true
        val chooseOnly = intent?.getBooleanExtra(EXTRA_CHOOSE_ONLY, false) == true // de titel in de widget: alleen het overzicht kiezen
        if (chooseOnly) findViewById<View>(R.id.config_save).visibility = View.GONE
        val list = findViewById<ListView>(R.id.config_list)
        // de opties als kop van de lijst: alles scrolt samen, ook op een klein scherm
        val options = LayoutInflater.from(this).inflate(R.layout.widget_config_options, list, false)
        list.addHeaderView(options, null, false)
        optionsView = options
        themeGroup = options.findViewById(R.id.config_theme)
        compact = options.findViewById(R.id.config_compact)
        opacity = options.findViewById(R.id.config_opacity)
        opacityValue = options.findViewById(R.id.config_opacity_value)
        accentSpinner = options.findViewById(R.id.config_accent)
        fontSpinner = options.findViewById(R.id.config_font)
        presetSpinner = options.findViewById(R.id.config_preset)
        showOptions(WidgetConfigStore.options(this, appWidgetId))

        val signedIn = Session.isActive(this)
        if (pickSource) {
            choices = WidgetChoices.list(WidgetStore.visibleSnapshot(this).takeIf { signedIn })
            selected = (WidgetSource.parse(WidgetConfigStore.get(this, appWidgetId)) ?: WidgetSource.Today).key
            if (!signedIn) {
                options.findViewById<View>(R.id.config_hint).visibility = View.VISIBLE
                options.findViewById<Button>(R.id.config_open_app).apply {
                    visibility = View.VISIBLE
                    setOnClickListener { startActivity(Intent(this@WidgetConfigActivity, MainActivity::class.java)) }
                }
            }
        } else {
            options.findViewById<View>(R.id.config_source_label).visibility = View.GONE
        }
        adapter = ChoiceAdapter()
        list.adapter = adapter
        installPreview()
        list.setOnItemClickListener { _, _, position, _ ->
            val index = position - list.headerViewsCount
            if (pickSource && index in choices.indices) {
                selected = choices[index].source.key
                adapter?.notifyDataSetChanged()
                refreshPreview()
                if (chooseOnly) save() // alleen kiezen: meteen bewaren en terug naar de startpagina
            }
        }
        findViewById<Button>(R.id.config_save).setOnClickListener { save() }
    }

    private fun showOptions(current: WidgetOptions) {
        themeGroup.check(
            when (current.theme) {
                WidgetTheme.SYSTEM -> R.id.config_theme_system
                WidgetTheme.LIGHT -> R.id.config_theme_light
                WidgetTheme.DARK -> R.id.config_theme_dark
            },
        )
        compact.isChecked = current.compact
        accentSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, WidgetAccent.entries.map { WidgetPalette.label(this, it) })
        accentSpinner.setSelection(current.accent.ordinal)
        fontSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf(R.string.widget_font_small, R.string.widget_font_normal, R.string.widget_font_large).map { getString(it) })
        fontSpinner.setSelection(current.font.ordinal)
        opacity.progress = current.opacity
        opacityValue.text = getString(R.string.widget_opacity_value, current.opacity)
        opacity.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                opacityValue.text = getString(R.string.widget_opacity_value, progress)
                refreshPreview()
            }
            override fun onStartTrackingTouch(bar: SeekBar) {}
            override fun onStopTrackingTouch(bar: SeekBar) {}
        })
        // de voorgestelde stijlen: Aangepast is wat er nu staat; een andere stijl vult de keuzes hierboven in
        presetSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, WidgetPreset.entries.map { presetLabel(it) })
        presetSpinner.setSelection(WidgetPreset.of(current).ordinal)
        presetSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val preset = WidgetPreset.entries[position]
                if (applyingPreset || preset == WidgetPreset.CUSTOM) return
                val next = preset.applyTo(chosenOptions())
                applyingPreset = true
                try {
                    showOptions(next)
                } finally {
                    applyingPreset = false
                }
                presetSpinner.setSelection(position)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    /** Het voorbeeld bovenaan, dat meebeweegt met elke keuze hieronder. */
    private fun installPreview() {
        previewBox = optionsView.findViewById(R.id.config_preview)
        val redraw = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = refreshPreview()
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        accentSpinner.onItemSelectedListener = redraw
        fontSpinner.onItemSelectedListener = redraw
        themeGroup.setOnCheckedChangeListener { _, _ -> refreshPreview() }
        compact.setOnCheckedChangeListener { _, _ -> refreshPreview() }
        refreshPreview()
    }

    private fun refreshPreview() {
        if (!::previewBox.isInitialized) return
        val title = choices.firstOrNull { it.source.key == selected }?.let { label(it) } ?: getString(R.string.widget_title_today)
        WidgetPreview.render(this, previewBox, chosenOptions(), title)
    }

    private fun presetLabel(p: WidgetPreset): String = getString(
        when (p) {
            WidgetPreset.CUSTOM -> R.string.widget_preset_custom
            WidgetPreset.STANDARD -> R.string.widget_preset_standard
            WidgetPreset.COMPACT -> R.string.widget_preset_compact
            WidgetPreset.TRANSPARENT_DARK -> R.string.widget_preset_transparent_dark
            WidgetPreset.TRANSPARENT_LIGHT -> R.string.widget_preset_transparent_light
        },
    )

    private fun chosenOptions(): WidgetOptions = WidgetOptions(
        theme = when (themeGroup.checkedRadioButtonId) {
            R.id.config_theme_light -> WidgetTheme.LIGHT
            R.id.config_theme_dark -> WidgetTheme.DARK
            else -> WidgetTheme.SYSTEM
        },
        compact = compact.isChecked,
        opacity = opacity.progress,
        accent = WidgetAccent.entries[accentSpinner.selectedItemPosition.coerceIn(0, WidgetAccent.entries.size - 1)],
        font = WidgetFont.entries[fontSpinner.selectedItemPosition.coerceIn(0, WidgetFont.entries.size - 1)],
    )

    private fun save() {
        selected?.let { WidgetConfigStore.set(this, appWidgetId, it) }
        WidgetConfigStore.setOptions(this, appWidgetId, chosenOptions())
        val manager = AppWidgetManager.getInstance(this)
        ListWidgets.update(this, manager, intArrayOf(appWidgetId), fixedSource(this, appWidgetId))
        WidgetUpdater.updateAll(this) // ook de lijst zelf (de regels lezen thema en lettergrootte)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }

    private fun label(choice: WidgetChoice): String = when (choice.kind) {
        WidgetChoice.Kind.TODAY -> getString(R.string.widget_title_today)
        WidgetChoice.Kind.UPCOMING -> getString(R.string.widget_title_upcoming)
        WidgetChoice.Kind.INBOX -> getString(R.string.widget_title_inbox)
        WidgetChoice.Kind.PROJECT -> choice.label.ifBlank { getString(R.string.widget_title_project_fallback) }
        WidgetChoice.Kind.FILTER -> choice.label.ifBlank { getString(R.string.widget_title_filter_fallback) }
        WidgetChoice.Kind.LABEL -> "@" + choice.label
        WidgetChoice.Kind.PRESET -> WidgetModel.presetTitle(this, (choice.source as WidgetSource.Preset).id)
    }

    private fun sectionTitle(section: WidgetChoice.Section): String = getString(
        when (section) {
            WidgetChoice.Section.DEFAULT -> R.string.widget_section_default
            WidgetChoice.Section.PROJECTS -> R.string.widget_section_projects
            WidgetChoice.Section.LABELS -> R.string.widget_section_labels
            WidgetChoice.Section.FILTERS -> R.string.widget_section_filters
        },
    )

    /** De keuzes voor wat de widget toont; de gekozen staat vet en in de kleur van de app. Leeg bij Vandaag en Binnenkort. */
    private inner class ChoiceAdapter : BaseAdapter() {
        override fun getCount() = choices.size
        override fun getItem(position: Int) = choices[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.item_widget_choice, parent, false)
            val view = row.findViewById<TextView>(R.id.choice_label)
            val choice = choices[position]
            // het kopje (Standaard weergaven, Projecten, Labels, Filters) staat boven de eerste keuze van elk soort
            val caption = row.findViewById<TextView>(R.id.choice_section)
            val first = position == 0 || choices[position - 1].section != choice.section
            caption.visibility = if (first) View.VISIBLE else View.GONE
            caption.text = sectionTitle(choice.section)
            view.text = label(choice)
            val on = choice.source.key == selected
            view.setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
            view.setTextColor(getColor(if (on) R.color.brand else R.color.text))
            view.isSelected = on
            val indent = resources.getDimensionPixelSize(R.dimen.widget_indent) * choice.depth
            view.setPaddingRelative(resources.getDimensionPixelSize(R.dimen.widget_config_start) + indent, view.paddingTop, view.paddingEnd, view.paddingBottom)
            return row
        }
    }

    companion object {
        /** Ja: alleen het overzicht kiezen (de titel van de widget): een keuze bewaart en sluit meteen, er is geen "Opslaan". */
        const val EXTRA_CHOOSE_ONLY = "io.github.wnijhof.tickory.extra.CHOOSE_ONLY"

        private val LIST_PROVIDERS = listOf(TodayWidgetProvider::class.java, UpcomingWidgetProvider::class.java, ProjectWidgetProvider::class.java)

        /** Is dit het id van een bestaande lijstwidget (Vandaag, Binnenkort, Project of lijst) van deze app? */
        fun isOwnWidget(context: Context, appWidgetId: Int): Boolean {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return false
            val manager = AppWidgetManager.getInstance(context)
            val provider = manager.getAppWidgetInfo(appWidgetId)?.provider
            return LIST_PROVIDERS.any { cls ->
                val component = ComponentName(context, cls)
                provider == component || appWidgetId in manager.getAppWidgetIds(component)
            }
        }

        /** Alleen bij de widget "Project of lijst" kies je wat hij toont. */
        fun isProjectWidget(context: Context, appWidgetId: Int): Boolean {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, ProjectWidgetProvider::class.java)
            return manager.getAppWidgetInfo(appWidgetId)?.provider == component || appWidgetId in manager.getAppWidgetIds(component)
        }

        /** De vaste bron van Vandaag en Binnenkort; null bij Project of lijst (die leest zijn bewaarde keuze). */
        private fun fixedSource(context: Context, appWidgetId: Int): WidgetSource? {
            val manager = AppWidgetManager.getInstance(context)
            fun on(cls: Class<*>) = appWidgetId in manager.getAppWidgetIds(ComponentName(context, cls)) || manager.getAppWidgetInfo(appWidgetId)?.provider == ComponentName(context, cls)
            return when {
                on(TodayWidgetProvider::class.java) -> WidgetSource.Today
                on(UpcomingWidgetProvider::class.java) -> WidgetSource.Upcoming
                else -> null
            }
        }
    }
}
