package io.github.wnijhof.tickory.quickadd

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateFormat
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import android.widget.ToggleButton
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.QueuedQuickAdd
import io.github.wnijhof.tickory.core.QuickAddChoice
import io.github.wnijhof.tickory.core.QuickAddChoices
import io.github.wnijhof.tickory.core.QuickAddPreview
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.QuickAddResult
import io.github.wnijhof.tickory.core.WidgetSnapshot
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.QuickAddStore
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler
import io.github.wnijhof.tickory.widget.WidgetModel
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.concurrent.Executor

/**
 * Het kleine venster "Taak toevoegen" over het startscherm, zoals bij de widget van Todoist: geopend door de "+" van een widget,
 * de knop-widget en de tegel in de snelle instellingen. Zonder WebView: een veld (met het toetsenbord meteen omhoog), het project,
 * Vandaag, Morgen en een prioriteit, en Toevoegen (of Enter).
 *
 * Toevoegen zet de taak in een wachtrij op het toestel (QuickAddStore) en laat de gewone verversing (SyncWorker) hem versturen:
 * met verbinding binnen een paar seconden, anders zodra er weer verbinding is. Wat de tekst wordt (datum, project, labels), beslist
 * de server met dezelfde herkenner als de web-app; tijdens het typen laat het venster dat zien als je verbinding hebt
 * (voorvertoning, `dry_run`). Terug of ernaast tikken sluit zonder toe te voegen; staat er tekst, dan blijft die als concept staan
 * tot de volgende keer (en dat zegt het venster).
 *
 * Alleen de app zelf kan het openen (exported="false"); het token blijft in de Keystore.
 */
class QuickAddActivity : ComponentActivity() {
    private lateinit var input: EditText
    private lateinit var projectButton: Button
    private lateinit var today: ToggleButton
    private lateinit var tomorrow: ToggleButton
    private lateinit var priorityButton: Button
    private lateinit var addButton: Button
    private lateinit var preview: LinearLayout
    private lateinit var previewScroll: View
    private lateinit var status: TextView

    private var snapshot: WidgetSnapshot? = null
    private var account: String? = null
    private var choices: List<QuickAddChoice> = emptyList()

    /** Het gekozen project; null is de Inbox. */
    private var projectId: String? = null
    private var priority: Int? = null

    /** Toegevoegd, bewust gesloten of naar de app: dan niets meer als concept bewaren. */
    private var done = false
    private var keyboardShown = false
    private var previewSeq = 0
    private val handler = Handler(Looper.getMainLooper())
    private val previewTask = Runnable { requestPreview() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        val target = intent?.getStringExtra(DeepLink.EXTRA_ADD)
        if (!Session.isActive(app) || Prefs(app).cleartextToInternet) {
            // Niet (meer) aangemeld: de app zelf, met het inlogscherm; daarna opent die Taak toevoegen.
            done = true
            startActivity(
                Intent(this, MainActivity::class.java)
                    .putExtra(DeepLink.EXTRA_ADD, target?.takeIf { it == "today" || Ids.isSafeId(it) } ?: "")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            )
            finish()
            return
        }
        enableEdgeToEdge()
        setContentView(R.layout.activity_quick_add)

        input = findViewById(R.id.quick_input)
        projectButton = findViewById(R.id.quick_project)
        today = findViewById(R.id.quick_today)
        tomorrow = findViewById(R.id.quick_tomorrow)
        priorityButton = findViewById(R.id.quick_priority)
        addButton = findViewById(R.id.quick_add)
        preview = findViewById(R.id.quick_preview)
        previewScroll = findViewById(R.id.quick_preview_scroll)
        status = findViewById(R.id.quick_status)
        layOut()

        snapshot = WidgetStore.visibleSnapshot(app)
        account = snapshot?.accountId
        choices = QuickAddChoices.list(snapshot, getString(R.string.quick_inbox))
        val fromWidget = target?.takeIf { it != "today" && Ids.isSafeId(it) }
        projectId = if (savedInstanceState != null) savedInstanceState.getString(STATE_PROJECT)?.takeIf { id -> choices.any { it.id == id } }
        else QuickAddChoices.initial(choices, fromWidget, QuickAddStore.lastProject(app, account), snapshot?.inboxId)
        priority = savedInstanceState?.getInt(STATE_PRIORITY, 0)?.takeIf { it in 1..4 }
        if (savedInstanceState == null) today.isChecked = target == "today"

        input.setHorizontallyScrolling(false)
        input.maxLines = 5
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                updateAddButton()
                if (status.isVisible && !s.isNullOrBlank()) status.isVisible = false
                schedulePreview()
            }
        })
        input.setOnEditorActionListener { _, actionId, event ->
            val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER
            if (actionId == EditorInfo.IME_ACTION_DONE || enter) {
                if (event == null || event.action == KeyEvent.ACTION_DOWN) add()
                true
            } else {
                false
            }
        }
        if (savedInstanceState == null) {
            val draft = QuickAddStore.draft(app, account)
            // zonder concept: een taak die niet aankwam terwijl de app geen meldingen mocht tonen, met de reden
            val returned = if (draft == null) QuickAddStore.takeReturned(app, account) else null
            val text = draft ?: returned?.text
            if (text != null) {
                input.setText(text)
                input.setSelection(input.text.length)
                showStatus(if (returned != null) getString(R.string.quick_returned, returned.why) else getString(R.string.quick_draft_restored))
            }
            returned?.projectId?.takeIf { id -> choices.any { it.id == id } }?.let { projectId = it }
        }

        projectButton.setOnClickListener { chooseProject() }
        priorityButton.setOnClickListener { choosePriority() }
        today.setOnCheckedChangeListener { _, on ->
            if (on) tomorrow.isChecked = false
            schedulePreview()
        }
        tomorrow.setOnCheckedChangeListener { _, on ->
            if (on) today.isChecked = false
            schedulePreview()
        }
        addButton.setOnClickListener { add() }
        findViewById<Button>(R.id.quick_open_app).setOnClickListener { openInApp() }
        findViewById<View>(R.id.quick_root).setOnClickListener { close() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = close()
            },
        )

        showProject()
        showPriority()
        updateAddButton()
        input.requestFocus()
        if (input.text.isNotBlank()) schedulePreview()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // het toetsenbord meteen omhoog, ook waar "stateAlwaysVisible" bij een doorzichtig venster niet genoeg is
        if (hasFocus && !keyboardShown && ::input.isInitialized) {
            keyboardShown = true
            input.requestFocus()
            WindowCompat.getInsetsController(window, input).show(WindowInsetsCompat.Type.ime())
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_PROJECT, projectId)
        outState.putInt(STATE_PRIORITY, priority ?: 0)
    }

    /** Naar de achtergrond (thuisknop, scherm uit, een andere app): het venster gaat dicht, de tekst blijft als concept. */
    override fun onStop() {
        super.onStop()
        if (!done && !isChangingConfigurations && ::input.isInitialized) {
            keepDraft()
            done = true
            finish()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(previewTask)
        super.onDestroy()
    }

    // ---------- de opmaak ----------

    /** Het vlak onderaan, boven de navigatiebalk en het toetsenbord; op een breed scherm niet breder dan 560 dp. */
    private fun layOut() {
        val root = findViewById<View>(R.id.quick_root)
        val sheet = findViewById<View>(R.id.quick_sheet)
        val widthDp = resources.configuration.screenWidthDp
        if (widthDp >= WIDE_DP) sheet.layoutParams = sheet.layoutParams.also { it.width = (SHEET_MAX_DP * resources.displayMetrics.density).toInt() }
        val start = sheet.paddingStart
        val top = sheet.paddingTop
        val end = sheet.paddingEnd
        val bottom = sheet.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(0, bars.top, 0, 0)
            sheet.setPaddingRelative(start + bars.left, top, end + bars.right, bottom + maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun updateAddButton() {
        val enabled = input.text.isNotBlank()
        addButton.isEnabled = enabled
        addButton.alpha = if (enabled) 1f else 0.5f
    }

    private fun showStatus(text: String) {
        status.text = text
        status.visibility = View.VISIBLE
    }

    private fun projectName(): String = choices.firstOrNull { it.id == projectId }?.name ?: getString(R.string.quick_inbox)

    private fun showProject() {
        val name = projectName()
        projectButton.text = if (projectId == null) name else getString(R.string.quick_project_named, name)
        projectButton.contentDescription = getString(R.string.quick_project_description, name)
    }

    private fun priorityLabel(p: Int?): String = getString(
        when (p) {
            1 -> R.string.quick_priority_1
            2 -> R.string.quick_priority_2
            3 -> R.string.quick_priority_3
            else -> R.string.quick_priority_4
        },
    )

    private fun showPriority() {
        priorityButton.text = if (priority != null && priority!! < 4) getString(R.string.quick_priority_short, priority!!) else getString(R.string.quick_priority)
        priorityButton.contentDescription = getString(R.string.quick_priority_description, priorityLabel(priority))
    }

    // ---------- kiezen ----------

    private fun chooseProject() {
        val labels = choices.map { "   ".repeat(it.depth) + it.name }.toTypedArray()
        val checked = choices.indexOfFirst { it.id == projectId }
        AlertDialog.Builder(this)
            .setTitle(R.string.quick_choose_project)
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                setProject(choices[which].id)
                dialog.dismiss()
            }
            .show()
    }

    /** Een project kiezen; het venster onthoudt het voor de volgende keer (per gebruiker). */
    fun setProject(id: String?) {
        projectId = id?.takeIf { wanted -> choices.any { it.id == wanted } }
        QuickAddStore.setLastProject(applicationContext, account, projectId)
        showProject()
        schedulePreview()
    }

    private fun choosePriority() {
        val menu = PopupMenu(this, priorityButton)
        for (p in 1..4) menu.menu.add(0, p, p, priorityLabel(p))
        menu.setOnMenuItemClickListener { item ->
            setPriority(item.itemId)
            true
        }
        menu.show()
    }

    /** @param p 1 … 3, of 4 / null voor geen prioriteit */
    fun setPriority(p: Int?) {
        priority = p?.takeIf { it in 1..3 }
        showPriority()
        schedulePreview()
    }

    private fun dueChoice(): String? = when {
        today.isChecked -> QuickAddQueue.DUE_TODAY
        tomorrow.isChecked -> QuickAddQueue.DUE_TOMORROW
        else -> null
    }

    // ---------- toevoegen, sluiten, naar de app ----------

    private fun add() {
        val text = input.text.toString().trim().take(QuickAddQueue.MAX_TEXT)
        if (text.isEmpty()) return
        val app = applicationContext
        val token = TokenVault.load(app)
        if (token == null) {
            openInApp() // de aanmelding is weg: de app laat opnieuw inloggen, met de tekst erbij
            return
        }
        val now = AppClock.now()
        val item = QueuedQuickAdd(
            uuid = QuickAddQueue.newUuid(),
            text = text,
            projectId = projectId,
            due = dueChoice(),
            priority = priority,
            typedAt = typedAt(now),
            tz = ZoneId.systemDefault().id,
            accountId = account,
            session = QuickAddQueue.sessionTag(token),
            queuedAtMs = now,
        )
        if (!QuickAddStore.enqueue(app, item)) {
            showStatus(getString(R.string.quick_queue_full))
            return
        }
        QuickAddStore.clearDraft(app)
        SyncScheduler.refreshNow(app) // met verbinding gaat hij er nu meteen heen; anders zodra die er is
        val message = getString(if (isOnline(app)) R.string.quick_added else R.string.quick_added_offline)
        done = true
        Toast.makeText(app, message, Toast.LENGTH_SHORT).show()
        finish()
    }

    /** Terug, of naast het venster getikt: niets toevoegen; staat er tekst, dan blijft die als concept staan (en dat zeggen we). */
    private fun close() {
        if (input.text.isNotBlank()) Toast.makeText(applicationContext, R.string.quick_draft_saved, Toast.LENGTH_SHORT).show()
        keepDraft()
        done = true
        finish()
    }

    private fun keepDraft() {
        val text = input.text.toString()
        if (text.isBlank()) QuickAddStore.clearDraft(applicationContext) else QuickAddStore.saveDraft(applicationContext, account, text)
    }

    /** "Openen in de app": de volledige app op Taak toevoegen, met wat je typte, het project en de dag. */
    private fun openInApp() {
        val text = QuickAddQueue.textForApp(input.text.toString(), priority)
        val day = when (dueChoice()) {
            QuickAddQueue.DUE_TODAY -> QuickAddQueue.DUE_TODAY
            QuickAddQueue.DUE_TOMORROW -> Instant.ofEpochMilli(AppClock.now()).atZone(ZoneId.systemDefault()).toLocalDate().plusDays(1).toString()
            else -> null
        }
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (text.isNotBlank()) {
            intent.putExtra(DeepLink.EXTRA_DRAFT_TEXT, text)
            projectId?.let { intent.putExtra(DeepLink.EXTRA_DRAFT_PROJECT, it) }
            day?.let { intent.putExtra(DeepLink.EXTRA_DRAFT_DUE, it) }
        } else {
            intent.putExtra(DeepLink.EXTRA_ADD, projectId ?: if (day == QuickAddQueue.DUE_TODAY) "today" else "")
        }
        QuickAddStore.clearDraft(applicationContext)
        done = true
        startActivity(intent)
        finish()
    }

    // ---------- de voorvertoning ----------

    private fun schedulePreview() {
        handler.removeCallbacks(previewTask)
        previewSeq += 1
        if (input.text.isBlank()) {
            showPreview(null)
            return
        }
        handler.postDelayed(previewTask, previewDelayMs)
    }

    /** Vraagt de server wat de tekst wordt (niets wordt aangemaakt). Zonder verbinding, of als het niet lukt: geen voorvertoning. */
    private fun requestPreview() {
        val app = applicationContext
        val origin = Prefs(app).serverOrigin
        if (origin == null || !isOnline(app)) {
            showPreview(null)
            return
        }
        val seq = previewSeq
        val body = QuickAddQueue.previewBody(input.text.toString().trim().take(QuickAddQueue.MAX_TEXT), projectId, dueChoice(), priority, typedAt(AppClock.now()), ZoneId.systemDefault().id, getString(R.string.language_code))
        previewExecutor.execute {
            val token = TokenVault.load(app)
            val result = if (token == null) null else ApiClient(origin, 4_000, 6_000, Session.userAgent).quickAdd(token, body)
            runOnUiThread { if (seq == previewSeq && !isFinishing && !isDestroyed) showPreview((result as? QuickAddResult.Ok)?.preview) }
        }
    }

    private fun showPreview(p: QuickAddPreview?) {
        preview.removeAllViews()
        if (p == null) {
            previewScroll.visibility = View.GONE
            return
        }
        val now = AppClock.now()
        val zone = ZoneId.systemDefault()
        val lang = WidgetModel.lang(this)
        val clock24 = DateFormat.is24HourFormat(this)
        val chips = ArrayList<String>()
        chips.add(p.content.ifBlank { getString(R.string.quick_preview_no_name) })
        p.due?.let { due ->
            val day = DueText.format(due.date, now, zone, lang, clock24) ?: due.date
            chips.add(if (due.recurring) getString(R.string.quick_recurring, due.string?.takeIf(String::isNotBlank) ?: day) else day)
        }
        p.deadline?.let { chips.add(getString(R.string.quick_preview_deadline, DueText.format(it, now, zone, lang, clock24) ?: it)) }
        val sameProject = if (projectId == null) p.inbox else p.projectId == projectId
        if (!sameProject) chips.add("#${p.projectName}")
        p.sectionName?.let { chips.add("/$it") }
        for ((name, fresh) in p.labels) chips.add(if (fresh) getString(R.string.quick_preview_new_label, name) else "@$name")
        if (p.priority < 4) chips.add(getString(R.string.quick_priority_short, p.priority))
        for (r in p.reminders) {
            val text = if (r.date != null) DueText.format(r.date, now, zone, lang, clock24) ?: r.date else offsetText(r.minuteOffset ?: 0)
            chips.add(getString(R.string.quick_preview_reminder, text))
        }
        for (text in chips) {
            val chip = TextView(this, null, 0, R.style.QuickPreviewChip)
            chip.text = text
            chip.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            preview.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).also { it.marginEnd = (6 * resources.displayMetrics.density).toInt() })
        }
        preview.contentDescription = getString(R.string.quick_preview_description, chips.joinToString(", "))
        previewScroll.visibility = View.VISIBLE
    }

    /** "30 min ervoor", "2 uur ervoor", "1 dag ervoor", "op het tijdstip". */
    private fun offsetText(minutes: Int): String = when {
        minutes <= 0 -> getString(R.string.quick_reminder_at_time)
        minutes % 1440 == 0 -> resources.getQuantityString(R.plurals.quick_reminder_days, minutes / 1440, minutes / 1440)
        minutes % 60 == 0 -> getString(R.string.quick_reminder_hours, minutes / 60)
        else -> getString(R.string.quick_reminder_minutes, minutes)
    }

    companion object {
        private const val STATE_PROJECT = "project"
        private const val STATE_PRIORITY = "priority"
        private const val WIDE_DP = 600
        private const val SHEET_MAX_DP = 560

        /** Zo lang na de laatste toetsaanslag vraagt het venster de voorvertoning (tests zetten het op 0). */
        @Volatile
        var previewDelayMs: Long = 450

        /** Waar het verzoek voor de voorvertoning draait (tests: meteen). */
        @Volatile
        var previewExecutor: Executor = Executor { Background.executor.execute(it) }

        /** Is er een netwerk met internet? (Tests zetten dit vast.) */
        @Volatile
        var isOnline: (Context) -> Boolean = { context ->
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val caps = manager?.getNetworkCapabilities(manager.activeNetwork)
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        }

        /** Het moment als tijd met de UTC-afwijking van het toestel, op de seconde: "2026-11-13T23:30+01:00". */
        fun typedAt(nowMs: Long): String = OffsetDateTime.ofInstant(Instant.ofEpochMilli(nowMs), ZoneId.systemDefault()).truncatedTo(ChronoUnit.SECONDS).toString()
    }
}
