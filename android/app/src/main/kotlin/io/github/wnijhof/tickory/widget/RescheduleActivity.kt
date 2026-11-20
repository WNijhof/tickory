package io.github.wnijhof.tickory.widget

import android.app.DatePickerDialog
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.BatchResult
import io.github.wnijhof.tickory.core.CommandStatus
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.Reschedule
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.core.WidgetTask
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/**
 * Herplannen vanuit een lijstwidget, zoals in Todoist (de knop naast "Over tijd" opent daar SchedulerDialogActivity met de te late taken):
 * een klein venster over het startscherm met Vandaag, Morgen, Dit weekend, Volgende week, Geen datum en "Datum kiezen…". De keuze gaat
 * meteen naar de server (één `task_update` per taak, met het tijdstip en de herhaling zoals ze waren); lukt dat niet (geen verbinding),
 * dan zegt het venster dat. Alleen de app zelf kan het openen (exported="false"); de id's worden gecontroleerd.
 */
class RescheduleActivity : ComponentActivity() {
    private var tasks: List<WidgetTask> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        val ids = intent?.getStringArrayExtra(EXTRA_TASK_IDS)?.filter(Ids::isSafeId)?.toSet().orEmpty()
        val snapshot = if (Session.isActive(app)) WidgetStore.visibleSnapshot(app) else null
        val queued = WidgetStore.queue(app).mapTo(HashSet()) { it.taskId }
        tasks = snapshot?.tasks?.filter { it.id in ids && it.id !in queued && snapshot.project(it.projectId)?.readOnly != true }.orEmpty()
        if (snapshot == null || tasks.isEmpty()) {
            finish()
            return
        }
        enableEdgeToEdge()
        setContentView(R.layout.activity_reschedule)
        layOut()
        findViewById<TextView>(R.id.reschedule_count).text = getString(R.string.reschedule_count, tasks.size)

        val zone = ZoneId.systemDefault()
        val today = Instant.ofEpochMilli(AppClock.now()).atZone(zone).toLocalDate()
        val c = Reschedule.choices(today, snapshot.nextWeekDay, snapshot.weekendDay)
        val box = findViewById<LinearLayout>(R.id.reschedule_choices)
        fun choice(label: Int, date: LocalDate?) = box.addView(row(getString(label), date?.let { weekday(it) }) { apply(date) })
        choice(R.string.reschedule_today, c.today)
        choice(R.string.reschedule_tomorrow, c.tomorrow)
        choice(R.string.reschedule_weekend, c.weekend)
        choice(R.string.reschedule_next_week, c.nextWeek)
        choice(R.string.reschedule_no_date, null)
        box.addView(row(getString(R.string.reschedule_pick), null) {
            DatePickerDialog(this, { _, y, m, d -> apply(LocalDate.of(y, m + 1, d)) }, today.year, today.monthValue - 1, today.dayOfMonth).show()
        })

        findViewById<View>(R.id.reschedule_root).setOnClickListener { finish() }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finish()
        })
    }

    private fun weekday(date: LocalDate): String = date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()).trimEnd('.')

    /** Een keuze: links de naam, rechts de weekdag; minstens 48 dp hoog. */
    private fun row(label: String, hint: String?, onClick: () -> Unit): View {
        val row = LayoutInflater.from(this).inflate(R.layout.item_reschedule_choice, findViewById(R.id.reschedule_choices), false)
        row.findViewById<TextView>(R.id.choice_label).text = label
        row.findViewById<TextView>(R.id.choice_hint).apply {
            text = hint ?: ""
            visibility = if (hint == null) View.GONE else View.VISIBLE
        }
        row.contentDescription = if (hint == null) label else "$label, $hint"
        row.setOnClickListener { onClick() }
        return row
    }

    /** Stuur de nieuwe datum naar de server (op de achtergrond) en sluit het venster; de uitkomst komt als korte melding. */
    private fun apply(date: LocalDate?) {
        val app = applicationContext
        val chosen = tasks
        val text = if (date == null) getString(R.string.reschedule_done_none)
        else getString(R.string.reschedule_done, DueText.format(date.toString(), AppClock.now(), ZoneId.systemDefault(), WidgetModel.lang(this)) ?: date.toString())
        finish()
        Background.executor.execute {
            val ok = send(app, chosen, date)
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(app, if (ok) text else app.getString(R.string.reschedule_failed), Toast.LENGTH_LONG).show()
            }
            if (ok) SyncScheduler.refreshNow(app)
        }
    }

    /** Layout zoals het venster van een taak: onderaan, boven de navigatiebalk. */
    private fun layOut() {
        val root = findViewById<View>(R.id.reschedule_root)
        val sheet = findViewById<View>(R.id.reschedule_sheet)
        val start = sheet.paddingStart
        val end = sheet.paddingEnd
        val bottom = sheet.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(0, bars.top, 0, 0)
            sheet.setPaddingRelative(start + bars.left, sheet.paddingTop, end + bars.right, bottom + bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) finish()
    }

    companion object {
        const val EXTRA_TASK_IDS = "io.github.wnijhof.tickory.extra.TASK_IDS"

        /** Stuurt de nieuwe datum voor [tasks] naar de server. true als alles is gelukt. Ook voor de tests. */
        internal fun send(context: Context, tasks: List<WidgetTask>, date: LocalDate?): Boolean {
            val origin = Prefs(context).serverOrigin ?: return false
            val token = TokenVault.load(context) ?: return false
            val client = ApiClient(origin, 6_000, 10_000, Session.userAgent)
            var allOk = true
            for (part in tasks.chunked(WidgetQueue.BATCH)) {
                val result = client.sendCommands(token, Reschedule.commands(part, date))
                allOk = allOk && result is BatchResult.Done && result.statuses.values.all { it is CommandStatus.Ok }
            }
            return allOk
        }
    }
}
