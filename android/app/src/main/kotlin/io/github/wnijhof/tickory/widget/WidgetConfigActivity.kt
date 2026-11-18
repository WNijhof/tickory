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
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetChoice
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
    private lateinit var opacity: Spinner

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

        val pickSource = isProjectWidget(this, appWidgetId)
        val list = findViewById<ListView>(R.id.config_list)
        // de opties als kop van de lijst: alles scrolt samen, ook op een klein scherm
        val options = LayoutInflater.from(this).inflate(R.layout.widget_config_options, list, false)
        list.addHeaderView(options, null, false)
        optionsView = options
        themeGroup = options.findViewById(R.id.config_theme)
        compact = options.findViewById(R.id.config_compact)
        opacity = options.findViewById(R.id.config_opacity)
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
        list.setOnItemClickListener { _, _, position, _ ->
            val index = position - list.headerViewsCount
            if (pickSource && index in choices.indices) {
                selected = choices[index].source.key
                adapter?.notifyDataSetChanged()
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
        opacity.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, WidgetOptions.OPACITIES.map { getString(R.string.widget_opacity_value, it) })
        opacity.setSelection(WidgetOptions.OPACITIES.indexOf(current.opacity).coerceAtLeast(0))
    }

    private fun chosenOptions(): WidgetOptions = WidgetOptions(
        theme = when (themeGroup.checkedRadioButtonId) {
            R.id.config_theme_light -> WidgetTheme.LIGHT
            R.id.config_theme_dark -> WidgetTheme.DARK
            else -> WidgetTheme.SYSTEM
        },
        compact = compact.isChecked,
        opacity = WidgetOptions.OPACITIES.getOrElse(opacity.selectedItemPosition) { 100 },
    )

    private fun save() {
        selected?.let { WidgetConfigStore.set(this, appWidgetId, it) }
        WidgetConfigStore.setOptions(this, appWidgetId, chosenOptions())
        val manager = AppWidgetManager.getInstance(this)
        ListWidgets.update(this, manager, intArrayOf(appWidgetId), fixedSource(this, appWidgetId))
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }

    private fun label(choice: WidgetChoice): String = when (choice.kind) {
        WidgetChoice.Kind.TODAY -> getString(R.string.widget_title_today)
        WidgetChoice.Kind.UPCOMING -> getString(R.string.widget_title_upcoming)
        WidgetChoice.Kind.INBOX -> getString(R.string.widget_title_inbox)
        WidgetChoice.Kind.PROJECT -> choice.label.ifBlank { getString(R.string.widget_title_project_fallback) }
        WidgetChoice.Kind.FILTER -> getString(R.string.widget_choice_filter, choice.label.ifBlank { getString(R.string.widget_title_filter_fallback) })
    }

    /** De keuzes voor wat de widget toont; de gekozen staat vet en in de kleur van de app. Leeg bij Vandaag en Binnenkort. */
    private inner class ChoiceAdapter : BaseAdapter() {
        override fun getCount() = choices.size
        override fun getItem(position: Int) = choices[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = (convertView as? TextView) ?: LayoutInflater.from(parent.context).inflate(R.layout.item_widget_choice, parent, false) as TextView
            val choice = choices[position]
            view.text = label(choice)
            val on = choice.source.key == selected
            view.setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
            view.setTextColor(getColor(if (on) R.color.brand else R.color.text))
            view.isSelected = on
            val indent = resources.getDimensionPixelSize(R.dimen.widget_indent) * choice.depth
            view.setPaddingRelative(resources.getDimensionPixelSize(R.dimen.widget_config_start) + indent, view.paddingTop, view.paddingEnd, view.paddingBottom)
            return view
        }
    }

    companion object {
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
