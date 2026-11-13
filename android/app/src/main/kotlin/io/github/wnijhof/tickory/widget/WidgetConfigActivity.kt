package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetChoice
import io.github.wnijhof.tickory.core.WidgetChoices
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session

/**
 * Het scherm dat opent als je de widget "Project of lijst" plaatst (en als je hem later opnieuw instelt): kies Vandaag,
 * Binnenkort, de Inbox of een project. De lijst met keuzes komt uit [WidgetChoices] en is uitbreidbaar (filters volgen).
 * Zonder aanmelding zijn de vaste keuzes er wel; de projecten komen erbij zodra je bent ingelogd.
 *
 * Dit scherm moet voor Android bereikbaar zijn (exported), dus het controleert dat het widget-id echt van een widget
 * "Project of lijst" is voordat het iets bewaart.
 */
class WidgetConfigActivity : ComponentActivity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED) // sluit je dit scherm zonder te kiezen, dan wordt de widget niet geplaatst
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

        val signedIn = Session.isActive(this)
        val choices = WidgetChoices.list(WidgetStore.visibleSnapshot(this).takeIf { signedIn })
        if (!signedIn) {
            findViewById<View>(R.id.config_hint).visibility = View.VISIBLE
            findViewById<Button>(R.id.config_open_app).apply {
                visibility = View.VISIBLE
                setOnClickListener { startActivity(Intent(this@WidgetConfigActivity, MainActivity::class.java)) }
            }
        }
        val list = findViewById<ListView>(R.id.config_list)
        list.adapter = ChoiceAdapter(choices)
        list.setOnItemClickListener { _, _, position, _ -> choose(choices[position]) }
    }

    private fun choose(choice: WidgetChoice) {
        WidgetConfigStore.set(this, appWidgetId, choice.source.key)
        val manager = AppWidgetManager.getInstance(this)
        ListWidgets.update(this, manager, intArrayOf(appWidgetId), null)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }

    private fun label(choice: WidgetChoice): String = when (choice.kind) {
        WidgetChoice.Kind.TODAY -> getString(R.string.widget_title_today)
        WidgetChoice.Kind.UPCOMING -> getString(R.string.widget_title_upcoming)
        WidgetChoice.Kind.INBOX -> getString(R.string.widget_title_inbox)
        WidgetChoice.Kind.PROJECT -> choice.label.ifBlank { getString(R.string.widget_title_project_fallback) }
    }

    private inner class ChoiceAdapter(private val choices: List<WidgetChoice>) : BaseAdapter() {
        override fun getCount() = choices.size
        override fun getItem(position: Int) = choices[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = (convertView as? TextView) ?: LayoutInflater.from(parent.context).inflate(R.layout.item_widget_choice, parent, false) as TextView
            val choice = choices[position]
            view.text = label(choice)
            val indent = resources.getDimensionPixelSize(R.dimen.widget_indent) * choice.depth
            view.setPaddingRelative(resources.getDimensionPixelSize(R.dimen.widget_config_start) + indent, view.paddingTop, view.paddingEnd, view.paddingBottom)
            return view
        }
    }

    companion object {
        /** Is dit het id van een bestaande widget "Project of lijst" van deze app? */
        fun isOwnWidget(context: Context, appWidgetId: Int): Boolean {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return false
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, ProjectWidgetProvider::class.java)
            return manager.getAppWidgetInfo(appWidgetId)?.provider == provider || appWidgetId in manager.getAppWidgetIds(provider)
        }
    }
}
