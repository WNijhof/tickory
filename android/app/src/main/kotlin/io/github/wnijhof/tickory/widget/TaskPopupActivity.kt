package io.github.wnijhof.tickory.widget

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateFormat
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
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
import io.github.wnijhof.tickory.core.DueChange
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.QuickAddChoices
import io.github.wnijhof.tickory.core.Reschedule
import io.github.wnijhof.tickory.core.TaskEdit
import io.github.wnijhof.tickory.core.TaskEdits
import io.github.wnijhof.tickory.core.WidgetSnapshot
import io.github.wnijhof.tickory.core.WidgetTask
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.Notifications
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
import java.util.concurrent.Executor

/**
 * Het venster van een taak over het startscherm, zoals bij Todoist: een tik op een taak in een widget opent dit venster in plaats van de
 * hele app, en je past de taak er meteen in aan. Bovenaan het project (tik = verplaatsen), dan de titel en de beschrijving om te typen, en
 * de datum, de prioriteit en de labels als regels om op te tikken. "Voltooien" vinkt de taak af; "Openen in de app" is er voor subtaken,
 * opmerkingen en de rest.
 *
 * Opslaan gaat vanzelf, zoals bij Todoist: bij terug, ernaast tikken of Klaar op het toetsenbord stuurt het venster wat er veranderd is
 * naar de server (`task_update`, en `task_move` voor een ander project) en sluit het. Lukt dat niet (geen verbinding), dan blijft het open
 * met de reden: nog eens proberen, of nog een keer terug om de wijzigingen weg te gooien. Gaat het venster naar de achtergrond (de
 * thuisknop), dan probeert het op de achtergrond op te slaan en zegt het als dat niet lukte.
 *
 * Het leest de bewaarde momentopname van de widgets (geen netwerk om te openen). Is de taak er niet (meer) of ben je niet aangemeld, dan
 * gaat de app zelf open. Een project dat je alleen leest: alleen bekijken. Alleen de app zelf kan het openen (exported="false").
 */
class TaskPopupActivity : ComponentActivity() {
    private lateinit var task: WidgetTask
    private lateinit var snapshot: WidgetSnapshot
    private lateinit var title: EditText
    private lateinit var description: EditText
    private lateinit var projectButton: Button
    private lateinit var rows: LinearLayout
    private lateinit var status: TextView

    private var readOnly = false
    private var priority = 4
    private var labelIds: List<String> = emptyList()
    private var due: DueChange? = null
    private var projectId = ""

    /** Klaar: opgeslagen, bewust weggegooid of naar de app; dan niets meer doen bij het sluiten. */
    private var done = false
    private var saving = false

    /** Opslaan lukte net niet: nog een keer terug gooit de wijzigingen weg. */
    private var failedOnce = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        val id = intent?.getStringExtra(Notifications.EXTRA_TASK_ID)?.takeIf(Ids::isSafeId)
        val snap = if (id != null && Session.isActive(app)) WidgetStore.visibleSnapshot(app) else null
        val found = snap?.tasks?.firstOrNull { it.id == id }
        if (id == null || snap == null || found == null) {
            // niet aangemeld, of de taak staat niet (meer) in de gegevens: gewoon de app, die weet het beter
            done = true
            if (id != null) openInApp(id)
            finish()
            return
        }
        task = found
        snapshot = snap
        readOnly = snap.project(found.projectId)?.readOnly == true
        priority = savedInstanceState?.getInt(STATE_PRIORITY, found.priority)?.takeIf { it in 1..4 } ?: found.priority
        labelIds = savedInstanceState?.getStringArray(STATE_LABELS)?.filter(Ids::isSafeId) ?: found.labelIds
        projectId = savedInstanceState?.getString(STATE_PROJECT)?.takeIf(Ids::isSafeId) ?: found.projectId
        due = savedInstanceState?.let { s ->
            if (!s.getBoolean(STATE_DUE_SET)) null else DueChange(s.getString(STATE_DUE)?.let { runCatching { LocalDate.parse(it) }.getOrNull() })
        }

        enableEdgeToEdge()
        setContentView(R.layout.activity_task_popup)
        layOut()
        title = findViewById(R.id.popup_content)
        description = findViewById(R.id.popup_description)
        projectButton = findViewById(R.id.popup_project)
        rows = findViewById(R.id.popup_rows)
        status = findViewById(R.id.popup_status)

        if (savedInstanceState == null) {
            title.setText(TaskEdit.editableTitle(found))
            description.setText(found.description ?: "")
        }
        if (found.description == null) {
            // te lang (of nog niet bekend): hier niet te bewerken, zodat er niets van verloren gaat
            description.isEnabled = false
            description.hint = getString(R.string.popup_description_in_app)
        }
        if (readOnly) {
            for (field in listOf(title, description)) {
                field.isFocusable = false
                field.isCursorVisible = false
                field.keyListener = null
            }
            status.text = getString(R.string.popup_read_only)
            status.setTextColor(getColor(R.color.text_soft))
            status.visibility = View.VISIBLE
            findViewById<View>(R.id.popup_complete).visibility = View.GONE // niet af te vinken
        } else {
            findViewById<Button>(R.id.popup_complete).setOnClickListener { complete() }
            projectButton.setOnClickListener { chooseProject() }
        }
        title.setOnEditorActionListener { _, actionId, event ->
            val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER
            if (actionId == EditorInfo.IME_ACTION_DONE || enter) {
                if (event == null || event.action == KeyEvent.ACTION_DOWN) close()
                true
            } else {
                false
            }
        }
        // de titel is één regel zoals in Todoist (Enter = klaar), maar loopt door over meer regels
        title.setHorizontallyScrolling(false)
        title.maxLines = 6

        findViewById<Button>(R.id.popup_open_app).setOnClickListener {
            saveInBackground()
            done = true
            openInApp(found.id)
            finish()
        }
        findViewById<View>(R.id.popup_root).setOnClickListener { close() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = close()
            },
        )
        showProject()
        showRows()
        showMeta()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!::task.isInitialized) return
        outState.putInt(STATE_PRIORITY, priority)
        outState.putStringArray(STATE_LABELS, labelIds.toTypedArray())
        outState.putString(STATE_PROJECT, projectId)
        outState.putBoolean(STATE_DUE_SET, due != null)
        outState.putString(STATE_DUE, due?.date?.toString())
    }

    /** Naar de achtergrond (thuisknop, een andere app): op de achtergrond opslaan en dicht. */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations && !done && ::task.isInitialized) {
            saveInBackground()
            done = true
            finish()
        }
    }

    // ---------- wat er staat ----------

    private fun projectLabel(id: String): String {
        val name = if (id == snapshot.inboxId) getString(R.string.quick_inbox) else snapshot.project(id)?.name ?: getString(R.string.quick_inbox)
        val section = if (id == task.projectId) task.sectionId?.let { s -> snapshot.sections.firstOrNull { it.id == s }?.name } else null
        return if (section.isNullOrBlank()) name else "$name / $section"
    }

    private fun showProject() {
        val label = projectLabel(projectId)
        projectButton.text = if (readOnly) label else "$label  ▾"
        projectButton.contentDescription = getString(R.string.popup_project_description, label)
    }

    /** De dag die er nu staat: gekozen in dit venster, anders die van de taak. */
    private fun shownDue(): String? = when (val d = due) {
        null -> task.due
        else -> d.date?.let { date -> task.due?.takeIf { it.length > 10 }?.let { "$date${it.substring(10)}" } ?: date.toString() }
    }

    private fun showRows() {
        rows.removeAllViews()
        val now = AppClock.now()
        val dueText = shownDue()?.let { DueText.format(it, now, ZoneId.systemDefault(), WidgetModel.lang(this), DateFormat.is24HourFormat(this)) ?: it }
            ?: getString(R.string.popup_no_date)
        row(getString(R.string.popup_date), dueText) { chooseDate() }
        row(getString(R.string.quick_priority), priorityLabel(priority)) { choosePriority(it) }
        val names = labelIds.mapNotNull { id -> snapshot.labels.firstOrNull { it.id == id }?.name }
        row(getString(R.string.popup_labels), names.joinToString(", ") { "@$it" }.ifEmpty { getString(R.string.popup_no_labels) }) { chooseLabels() }
    }

    /** Een regel: links de naam (Datum), rechts wat er nu is (morgen 09:00); minstens 48 dp hoog. */
    private fun row(label: String, value: String, onClick: (View) -> Unit) {
        val row = LayoutInflater.from(this).inflate(R.layout.item_reschedule_choice, rows, false)
        row.findViewById<TextView>(R.id.choice_label).text = label
        row.findViewById<TextView>(R.id.choice_hint).text = value
        row.contentDescription = if (readOnly) "$label: $value" else getString(R.string.popup_row_description, label, value)
        if (readOnly) row.isClickable = false else row.setOnClickListener { onClick(it) }
        rows.addView(row)
    }

    /** Onderaan: subtaken en opmerkingen (die bewerk je in de app). */
    private fun showMeta() {
        val parts = ArrayList<String>()
        val open = snapshot.tasks.count { it.parentId == task.id }
        if (open + task.doneSubtasks > 0) parts.add(getString(R.string.popup_subtasks, task.doneSubtasks, open + task.doneSubtasks))
        if (task.comments > 0) parts.add(resources.getQuantityString(R.plurals.popup_comments, task.comments, task.comments))
        findViewById<TextView>(R.id.popup_meta).text = parts.joinToString(" · ")
    }

    private fun priorityLabel(p: Int): String = getString(
        when (p) {
            1 -> R.string.quick_priority_1
            2 -> R.string.quick_priority_2
            3 -> R.string.quick_priority_3
            else -> R.string.quick_priority_4
        },
    )

    // ---------- kiezen ----------

    private fun chooseDate() {
        val today = Instant.ofEpochMilli(AppClock.now()).atZone(ZoneId.systemDefault()).toLocalDate()
        val c = Reschedule.choices(today, snapshot.nextWeekDay, snapshot.weekendDay)
        fun weekday(d: LocalDate) = d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()).trimEnd('.')
        val options = listOf(
            getString(R.string.reschedule_today) to c.today,
            getString(R.string.reschedule_tomorrow) to c.tomorrow,
            getString(R.string.reschedule_weekend) to c.weekend,
            getString(R.string.reschedule_next_week) to c.nextWeek,
        )
        val labels = options.map { (name, d) -> "$name  ·  ${weekday(d)}" } + getString(R.string.reschedule_no_date) + getString(R.string.reschedule_pick)
        AlertDialog.Builder(this)
            .setTitle(R.string.popup_date)
            .setItems(labels.toTypedArray()) { _, which ->
                when {
                    which < options.size -> setDue(options[which].second)
                    which == options.size -> setDue(null)
                    else -> {
                        val start = shownDue()?.take(10)?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: today
                        DatePickerDialog(this, { _, y, m, d -> setDue(LocalDate.of(y, m + 1, d)) }, start.year, start.monthValue - 1, start.dayOfMonth).show()
                    }
                }
            }
            .show()
    }

    /** Een andere dag (null = geen datum); het tijdstip en de herhaling blijven. Ook voor de tests. */
    fun setDue(date: LocalDate?) {
        due = DueChange(date)
        showRows()
    }

    private fun choosePriority(anchor: View) {
        val menu = PopupMenu(this, anchor)
        for (p in 1..4) menu.menu.add(0, p, p, priorityLabel(p))
        menu.setOnMenuItemClickListener { item ->
            setPriority(item.itemId)
            true
        }
        menu.show()
    }

    /** @param p 1 … 4 (4 = geen prioriteit). Ook voor de tests. */
    fun setPriority(p: Int) {
        if (p !in 1..4) return
        priority = p
        showRows()
    }

    private fun chooseLabels() {
        val all = snapshot.labels.sortedBy { it.name.lowercase() }
        if (all.isEmpty()) return
        val checked = BooleanArray(all.size) { all[it].id in labelIds }
        AlertDialog.Builder(this)
            .setTitle(R.string.popup_labels)
            .setMultiChoiceItems(all.map { "@${it.name}" }.toTypedArray(), checked) { _, which, on -> checked[which] = on }
            .setPositiveButton(android.R.string.ok) { _, _ ->
                // de volgorde zoals de taak ze had, nieuwe erachter
                val chosen = all.filterIndexed { i, _ -> checked[i] }.map { it.id }.toSet()
                setLabels(labelIds.filter { it in chosen } + chosen.filter { it !in labelIds })
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Ook voor de tests. */
    fun setLabels(ids: List<String>) {
        labelIds = ids.filter { id -> snapshot.labels.any { it.id == id } }.distinct()
        showRows()
    }

    private fun chooseProject() {
        val choices = QuickAddChoices.list(snapshot, getString(R.string.quick_inbox))
        val current = if (projectId == snapshot.inboxId) null else projectId
        AlertDialog.Builder(this)
            .setTitle(R.string.popup_move_to)
            .setSingleChoiceItems(choices.map { "   ".repeat(it.depth) + it.name }.toTypedArray(), choices.indexOfFirst { it.id == current }) { dialog, which ->
                setProject(choices[which].id ?: snapshot.inboxId)
                dialog.dismiss()
            }
            .show()
    }

    /** Naar een ander project (null of onbekend: niets). Ook voor de tests. */
    fun setProject(id: String?) {
        if (id == null || snapshot.project(id)?.readOnly != false) return
        projectId = id
        showProject()
    }

    // ---------- opslaan, voltooien, sluiten ----------

    /** Wat er nu anders is dan de taak. */
    fun edits(): TaskEdits =
        if (readOnly) TaskEdits() else TaskEdit.edits(task, title.text.toString(), description.text.toString(), priority, labelIds, due, projectId)

    /** Terug, ernaast tikken of Klaar: opslaan wat er veranderd is en dicht; lukt dat niet, dan blijft het venster open met de reden. */
    private fun close() {
        if (saving) return
        val edits = edits()
        if (edits.isEmpty || failedOnce) {
            if (!edits.isEmpty) Toast.makeText(applicationContext, R.string.popup_discarded, Toast.LENGTH_SHORT).show()
            done = true
            finish()
            return
        }
        saving = true
        status.setTextColor(getColor(R.color.text_soft))
        status.text = getString(R.string.popup_saving)
        status.visibility = View.VISIBLE
        val app = applicationContext
        val t = task
        saveExecutor.execute {
            val ok = send(app, t, edits)
            if (ok) SyncScheduler.refreshNow(app) // de widget ververst, ook als het venster intussen al dicht is
            runOnUiThread {
                saving = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (ok) {
                    Toast.makeText(app, R.string.popup_saved, Toast.LENGTH_SHORT).show()
                    done = true
                    finish()
                } else {
                    failedOnce = true
                    status.setTextColor(getColor(R.color.danger))
                    status.text = getString(R.string.popup_save_failed)
                }
            }
        }
    }

    /** Op de achtergrond opslaan (het venster gaat al dicht); lukt het niet, dan zegt een korte melding dat. */
    private fun saveInBackground() {
        if (saving) return
        val edits = edits()
        if (edits.isEmpty) return
        val app = applicationContext
        val t = task
        saveExecutor.execute {
            val ok = send(app, t, edits)
            Handler(Looper.getMainLooper()).post {
                if (ok) SyncScheduler.refreshNow(app) else Toast.makeText(app, R.string.popup_save_failed_later, Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Voltooien: eerst opslaan wat er veranderd is (op de achtergrond), dan afvinken zoals in de widget. */
    private fun complete() {
        saveInBackground()
        WidgetActions.complete(this, task.id)
        Toast.makeText(applicationContext, R.string.popup_completed, Toast.LENGTH_SHORT).show()
        done = true
        finish()
    }

    private fun openInApp(id: String) {
        try {
            startActivity(WidgetIntents.openTask(this, id))
        } catch (_: ActivityNotFoundException) {
            // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
        }
    }

    /** Het vlak onderaan, boven de navigatiebalk en het toetsenbord; op een breed scherm niet breder dan 560 dp. */
    private fun layOut() {
        val root = findViewById<View>(R.id.popup_root)
        val sheet = findViewById<View>(R.id.popup_sheet)
        if (resources.configuration.screenWidthDp >= WIDE_DP) sheet.layoutParams = sheet.layoutParams.also { it.width = (SHEET_MAX_DP * resources.displayMetrics.density).toInt() }
        val start = sheet.paddingStart
        val end = sheet.paddingEnd
        val bottom = sheet.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(0, bars.top, 0, 0)
            sheet.setPaddingRelative(start + bars.left, sheet.paddingTop, end + bars.right, bottom + maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    companion object {
        private const val WIDE_DP = 600
        private const val SHEET_MAX_DP = 560
        private const val STATE_PRIORITY = "priority"
        private const val STATE_LABELS = "labels"
        private const val STATE_PROJECT = "project"
        private const val STATE_DUE_SET = "dueSet"
        private const val STATE_DUE = "due"

        /** Waar het opslaan draait (tests: meteen). */
        @Volatile
        var saveExecutor: Executor = Executor { Background.executor.execute(it) }

        /** Stuurt de wijzigingen naar de server. true als alles gelukt is. */
        internal fun send(context: Context, task: WidgetTask, edits: TaskEdits): Boolean {
            val origin = Prefs(context).serverOrigin ?: return false
            val token = TokenVault.load(context) ?: return false
            val commands = TaskEdit.commands(task, edits)
            if (commands.isEmpty()) return true
            val result = ApiClient(origin, 6_000, 10_000, Session.userAgent).sendCommands(token, commands)
            return result is BatchResult.Done && commands.all { result.statuses[it.uuid] is CommandStatus.Ok }
        }
    }
}
