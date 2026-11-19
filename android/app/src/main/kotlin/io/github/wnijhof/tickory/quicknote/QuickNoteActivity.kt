package io.github.wnijhof.tickory.quicknote

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import android.widget.ToggleButton
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import io.github.wnijhof.tickory.AppShortcuts
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.QueuedNote
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.QuickNoteQueue
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.QuickNoteStore
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler

/**
 * Het kleine venster "Notitie toevoegen" over het startscherm, op dezelfde manier als "Taak toevoegen" (QuickAddActivity): geopend
 * door de "+" van de widget Notities, de knop-widget, de widget Snelle acties, de tegel in de snelle instellingen en de snelkoppeling.
 * Zonder WebView: een titel, de tekst (met een knop voor een checklist), vastpinnen, en Toevoegen.
 *
 * Toevoegen zet de notitie in een wachtrij op het toestel (QuickNoteStore) en laat de gewone verversing (SyncWorker) hem versturen:
 * met verbinding binnen een paar seconden, anders zodra er weer verbinding is. Terug of ernaast tikken sluit zonder toe te voegen;
 * staat er tekst, dan blijft die als concept staan tot de volgende keer (en dat zegt het venster).
 *
 * Alleen de app zelf kan het openen (exported="false"); het token blijft in de Keystore.
 */
class QuickNoteActivity : ComponentActivity() {
    private lateinit var titleInput: EditText
    private lateinit var bodyInput: EditText
    private lateinit var pin: ToggleButton
    private lateinit var addButton: Button
    private lateinit var status: TextView

    private var account: String? = null

    /** Toegevoegd, bewust gesloten of naar de app: dan niets meer als concept bewaren. */
    private var done = false
    private var keyboardShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        if (!Session.isActive(app) || Prefs(app).cleartextToInternet) {
            // Niet (meer) aangemeld: de app zelf, met het inlogscherm; daarna opent die een nieuwe notitie.
            done = true
            startActivity(openAppIntent(this))
            finish()
            return
        }
        enableEdgeToEdge()
        setContentView(R.layout.activity_quick_note)
        titleInput = findViewById(R.id.note_title)
        bodyInput = findViewById(R.id.note_body)
        pin = findViewById(R.id.note_pin)
        addButton = findViewById(R.id.note_add)
        status = findViewById(R.id.note_status)
        layOut()
        account = WidgetStore.visibleSnapshot(app)?.accountId

        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                updateAddButton()
                if (status.isVisible) status.isVisible = false
            }
        }
        titleInput.addTextChangedListener(watcher)
        bodyInput.addTextChangedListener(watcher)
        titleInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_NEXT) {
                bodyInput.requestFocus()
                true
            } else {
                false
            }
        }
        if (savedInstanceState == null) {
            QuickNoteStore.draft(app, account)?.let {
                titleInput.setText(it.title)
                bodyInput.setText(it.content)
                pin.isChecked = it.pinned
                (if (it.title.isBlank()) bodyInput else titleInput).setSelection((if (it.title.isBlank()) bodyInput else titleInput).text.length)
                showStatus(getString(R.string.quick_note_draft_restored))
            }
        }
        findViewById<Button>(R.id.note_checklist).setOnClickListener { insertChecklistItem() }
        addButton.setOnClickListener { add() }
        findViewById<Button>(R.id.note_open_app).setOnClickListener { openInApp() }
        findViewById<View>(R.id.note_root).setOnClickListener { close() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = close()
            },
        )
        updateAddButton()
        (if (titleInput.text.isBlank() || bodyInput.text.isBlank()) titleInput else bodyInput).requestFocus()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // het toetsenbord meteen omhoog, ook waar "stateAlwaysVisible" bij een doorzichtig venster niet genoeg is
        if (hasFocus && !keyboardShown && ::titleInput.isInitialized) {
            keyboardShown = true
            WindowCompat.getInsetsController(window, titleInput).show(WindowInsetsCompat.Type.ime())
        }
    }

    /** Naar de achtergrond (thuisknop, scherm uit, een andere app): het venster gaat dicht, de tekst blijft als concept. */
    override fun onStop() {
        super.onStop()
        if (!done && !isChangingConfigurations && ::titleInput.isInitialized) {
            keepDraft()
            done = true
            finish()
        }
    }

    // ---------- de opmaak ----------

    /** Het vlak onderaan, boven de navigatiebalk en het toetsenbord; op een breed scherm niet breder dan 560 dp. */
    private fun layOut() {
        val root = findViewById<View>(R.id.note_root)
        val sheet = findViewById<View>(R.id.note_sheet)
        if (resources.configuration.screenWidthDp >= WIDE_DP) sheet.layoutParams = sheet.layoutParams.also { it.width = (SHEET_MAX_DP * resources.displayMetrics.density).toInt() }
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
        val enabled = !QuickNoteQueue.isEmpty(titleInput.text.toString(), bodyInput.text.toString())
        addButton.isEnabled = enabled
        addButton.alpha = if (enabled) 1f else 0.5f
    }

    private fun showStatus(text: String) {
        status.text = text
        status.visibility = View.VISIBLE
    }

    /** Een regel "- [ ] " op de plek van de cursor (aan het begin van de regel); zo wordt het een checklist in de notitie. */
    private fun insertChecklistItem() {
        val text = bodyInput.text
        val pos = bodyInput.selectionStart.coerceAtLeast(0)
        val lineStart = text.lastIndexOf('\n', pos - 1) + 1
        val lineEnd = text.indexOf('\n', pos).let { if (it < 0) text.length else it }
        if (text.substring(lineStart, lineEnd).isNotEmpty() && !text.substring(lineStart, lineEnd).startsWith(ITEM)) {
            // de regel heeft al tekst: een nieuwe regel eronder
            text.insert(lineEnd, "\n$ITEM")
            bodyInput.setSelection(lineEnd + 1 + ITEM.length)
        } else if (!text.substring(lineStart, lineEnd).startsWith(ITEM)) {
            text.insert(lineStart, ITEM)
            bodyInput.setSelection(lineStart + ITEM.length)
        } else {
            text.insert(lineEnd, "\n$ITEM")
            bodyInput.setSelection(lineEnd + 1 + ITEM.length)
        }
        bodyInput.requestFocus()
    }

    // ---------- toevoegen, sluiten, naar de app ----------

    private fun add() {
        val title = titleInput.text.toString().trim().take(QuickNoteQueue.MAX_TITLE)
        val content = bodyInput.text.toString().trim().take(QuickNoteQueue.MAX_CONTENT)
        if (QuickNoteQueue.isEmpty(title, content)) return
        val app = applicationContext
        val token = TokenVault.load(app)
        if (token == null) {
            openInApp() // de aanmelding is weg: de app laat opnieuw inloggen
            return
        }
        val item = QueuedNote(
            uuid = QuickNoteQueue.newUuid(),
            noteId = QuickNoteQueue.newNoteId(),
            title = title,
            content = content,
            pinned = pin.isChecked,
            accountId = account,
            session = QuickAddQueue.sessionTag(token),
            queuedAtMs = AppClock.now(),
        )
        if (!QuickNoteStore.enqueue(app, item)) {
            showStatus(getString(R.string.quick_note_queue_full))
            return
        }
        QuickNoteStore.clearDraft(app)
        SyncScheduler.refreshNow(app) // met verbinding gaat hij er nu meteen heen; anders zodra die er is
        done = true
        Toast.makeText(app, getString(if (isOnline(app)) R.string.quick_note_added else R.string.quick_note_added_offline), Toast.LENGTH_SHORT).show()
        finish()
    }

    /** Terug, of naast het venster getikt: niets toevoegen; staat er tekst, dan blijft die als concept staan (en dat zeggen we). */
    private fun close() {
        if (!QuickNoteQueue.isEmpty(titleInput.text.toString(), bodyInput.text.toString())) Toast.makeText(applicationContext, R.string.quick_note_draft_saved, Toast.LENGTH_SHORT).show()
        keepDraft()
        done = true
        finish()
    }

    private fun keepDraft() {
        QuickNoteStore.saveDraft(applicationContext, account, QuickNoteStore.Draft(titleInput.text.toString(), bodyInput.text.toString(), pin.isChecked))
    }

    /** "Openen in de app": de volledige app op een nieuwe notitie (wat je typte blijft als concept staan). */
    private fun openInApp() {
        keepDraft()
        done = true
        startActivity(openAppIntent(this))
        finish()
    }

    companion object {
        private const val ITEM = "- [ ] "
        private const val WIDE_DP = 600
        private const val SHEET_MAX_DP = 560

        /** De intentie van de widgets, de tegel en de snelkoppeling: dit venster, expliciet, als eigen taak. */
        fun launchIntent(context: Context): Intent =
            Intent(context, QuickNoteActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        private fun openAppIntent(context: Context): Intent =
            Intent(context, MainActivity::class.java)
                .setAction(AppShortcuts.ACTION)
                .putExtra(DeepLink.EXTRA_VIEW, DeepLink.VIEW_NEW_NOTE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        /** Is er een netwerk met internet? (Tests zetten dit vast.) */
        @Volatile
        var isOnline: (Context) -> Boolean = { context ->
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val caps = manager?.getNetworkCapabilities(manager.activeNetwork)
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        }
    }
}
