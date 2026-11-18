package io.github.wnijhof.tickory.widget

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.text.format.DateFormat
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import java.time.ZoneId

/**
 * Het kleine venster van een taak over het startscherm, zoals bij Todoist: een tik op een taak in een widget opent dit venster in plaats van
 * de hele app. Het toont de titel, het project, de datum en de prioriteit, met "Voltooien" en "Openen in de app". Het leest alleen de gegevens
 * op het toestel (de bewaarde momentopname van de widgets), nooit het netwerk. Is de taak er niet (meer) of ben je niet aangemeld, dan gaat
 * de app zelf open. Alleen de app zelf kan het openen (exported="false"); het id wordt gecontroleerd.
 */
class TaskPopupActivity : ComponentActivity() {
    private var taskId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        val id = intent?.getStringExtra(Notifications.EXTRA_TASK_ID)?.takeIf(Ids::isSafeId)
        val snapshot = if (id != null && Session.isActive(app)) WidgetStore.visibleSnapshot(app) else null
        val task = snapshot?.tasks?.firstOrNull { it.id == id }
        if (id == null || task == null) {
            // niet aangemeld, of de taak staat niet (meer) in de gegevens: gewoon de app, die weet het beter
            if (id != null) openInApp(id)
            finish()
            return
        }
        taskId = id
        enableEdgeToEdge()
        setContentView(R.layout.activity_task_popup)
        layOut()

        val project = snapshot.project(task.projectId)
        findViewById<TextView>(R.id.popup_content).text = task.content
        val now = AppClock.now()
        val parts = ArrayList<String>()
        project?.let { parts.add(it.name) }
        task.due?.let { due ->
            parts.add(DueText.format(due, now, ZoneId.systemDefault(), WidgetModel.lang(this), DateFormat.is24HourFormat(this)) ?: due)
        }
        if (task.priority < 4) parts.add(getString(R.string.quick_priority_short, task.priority))
        findViewById<TextView>(R.id.popup_meta).apply {
            text = parts.joinToString(" · ")
            visibility = if (parts.isEmpty()) View.GONE else View.VISIBLE
        }

        val complete = findViewById<Button>(R.id.popup_complete)
        if (project?.readOnly == true) {
            complete.visibility = View.GONE // een project dat je alleen leest: niet af te vinken
        } else {
            complete.setOnClickListener {
                WidgetActions.complete(this, id)
                Toast.makeText(applicationContext, R.string.popup_completed, Toast.LENGTH_SHORT).show()
                finish()
            }
        }
        findViewById<Button>(R.id.popup_open_app).setOnClickListener {
            openInApp(id)
            finish()
        }
        findViewById<View>(R.id.popup_root).setOnClickListener { finish() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = finish()
            },
        )
    }

    /** Naar de achtergrond (thuisknop, een andere app): het venster gaat dicht. */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) finish()
    }

    private fun openInApp(id: String) {
        try {
            startActivity(WidgetIntents.openTask(this, id))
        } catch (_: ActivityNotFoundException) {
            // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
        }
    }

    /** Het vlak onderaan, boven de navigatiebalk; op een breed scherm niet breder dan 560 dp. */
    private fun layOut() {
        val root = findViewById<View>(R.id.popup_root)
        val sheet = findViewById<View>(R.id.popup_sheet)
        if (resources.configuration.screenWidthDp >= WIDE_DP) sheet.layoutParams = sheet.layoutParams.also { it.width = (SHEET_MAX_DP * resources.displayMetrics.density).toInt() }
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

    private companion object {
        const val WIDE_DP = 600
        const val SHEET_MAX_DP = 560
    }
}
