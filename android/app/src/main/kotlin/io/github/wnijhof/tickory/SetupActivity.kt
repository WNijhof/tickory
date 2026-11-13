package io.github.wnijhof.tickory

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.HealthResult
import io.github.wnijhof.tickory.core.LocalNetwork
import io.github.wnijhof.tickory.core.NetProblem
import io.github.wnijhof.tickory.core.ServerAddress
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncWorker

/**
 * Het instelscherm: het adres van de eigen server invullen. Verschijnt bij de eerste start en na "Serveradres wijzigen".
 * Het adres wordt pas bewaard als GET /health op dat adres {"ok":true} geeft.
 */
class SetupActivity : ComponentActivity() {
    private lateinit var address: EditText
    private lateinit var httpWarning: TextView
    private lateinit var error: TextView
    private lateinit var connect: Button
    private lateinit var grant: Button
    private lateinit var settings: Button
    private lateinit var progress: ProgressBar

    /** Telt de pogingen, zodat een antwoord op een oudere poging niet meer wordt verwerkt. */
    private var attempt = 0

    /** Het adres waarvoor we de toestemming voor het thuisnetwerk aan het vragen zijn. */
    private var waitingForPermission: ServerAddress.Result.Ok? = null

    private val localNetworkPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val pending = waitingForPermission
        waitingForPermission = null
        if (granted && pending != null) {
            checkServer(pending, permissionHandled = true)
        } else if (!granted) {
            setBusy(false)
            showError(getString(R.string.local_network_denied), offerSettings = true)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        address = findViewById(R.id.address)
        httpWarning = findViewById(R.id.http_warning)
        error = findViewById(R.id.error)
        connect = findViewById(R.id.connect)
        grant = findViewById(R.id.grant)
        settings = findViewById(R.id.settings)
        progress = findViewById(R.id.progress)

        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        if (savedInstanceState == null) {
            intent.getStringExtra(EXTRA_PREVIOUS)?.let { address.setText(it) }
        }
        updateHttpWarning()

        address.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                updateHttpWarning()
                hideError()
            }
        })
        address.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                onConnect()
                true
            } else {
                false
            }
        }
        connect.setOnClickListener { onConnect() }
        grant.setOnClickListener {
            val parsed = ServerAddress.parse(address.text.toString())
            if (parsed is ServerAddress.Result.Ok) requestLocalNetwork(parsed) else onConnect()
        }
        settings.setOnClickListener { openAppSettings() }
    }

    override fun onDestroy() {
        attempt++ // een antwoord dat nog onderweg is, hoeft niet meer
        super.onDestroy()
    }

    private fun onConnect() {
        if (!connect.isEnabled) return
        when (val parsed = ServerAddress.parse(address.text.toString())) {
            is ServerAddress.Result.Invalid -> showError(
                getString(
                    when (parsed.problem) {
                        ServerAddress.Problem.EMPTY -> R.string.error_address_empty
                        ServerAddress.Problem.SCHEME -> R.string.error_address_scheme
                        ServerAddress.Problem.CREDENTIALS -> R.string.error_address_credentials
                        ServerAddress.Problem.INVALID -> R.string.error_address_invalid
                    },
                ),
            )
            is ServerAddress.Result.Ok -> checkServer(parsed, permissionHandled = false)
        }
    }

    /** Controleert op de achtergrond of er op dit adres een Tickory-server draait. */
    private fun checkServer(target: ServerAddress.Result.Ok, permissionHandled: Boolean) {
        hideError()
        setBusy(true)
        val current = ++attempt
        val permissionMissing = localNetworkPermissionMissing()
        Background.executor.execute {
            val local = LocalNetwork.hostLooksLocal(target.host) || LocalNetwork.resolvesToLocal(target.host)
            if (!ServerAddress.cleartextAllowed(target, local)) {
                // http:// naar een server buiten het eigen netwerk: wachtwoord en aanmelding zouden onversleuteld over de lijn gaan
                runOnUiThread { if (current == attempt && !isFinishing) fail(getString(R.string.error_http_not_local)) }
                return@execute
            }
            if (local && permissionMissing && !permissionHandled) {
                // Android 17 en nieuwer: eerst toestemming vragen, anders loopt het verzoek dood zonder duidelijke fout.
                runOnUiThread { if (current == attempt && !isFinishing) askLocalNetwork(target) }
                return@execute
            }
            var origin = target.origin
            var result = ApiClient(origin, CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, Session.userAgent).health()
            if (result is HealthResult.Redirect) {
                // http dat netjes doorverwijst naar https op dezelfde naam: dat adres nemen we over
                val upgraded = ServerAddress.httpsUpgradeOf(origin, result.location)
                if (upgraded != null) {
                    origin = upgraded
                    result = ApiClient(origin, CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, Session.userAgent).health()
                }
            }
            val finalOrigin = origin
            val finalResult = result
            runOnUiThread { if (current == attempt && !isFinishing) onResult(target, finalOrigin, local, finalResult) }
        }
    }

    private fun onResult(target: ServerAddress.Result.Ok, origin: String, local: Boolean, result: HealthResult) {
        when (result) {
            is HealthResult.Ok -> {
                Prefs(this).setServer(origin, local)
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
            is HealthResult.NotTickory -> fail(getString(R.string.error_not_tickory, result.status))
            is HealthResult.Redirect -> {
                val to = ServerAddress.originOf(result.location)
                fail(if (to != null) getString(R.string.error_redirect, to) else getString(R.string.error_redirect_unknown))
            }
            is HealthResult.Unreachable -> {
                val base = getString(
                    when (result.problem) {
                        NetProblem.UNKNOWN_HOST -> R.string.error_unknown_host
                        NetProblem.CONNECT -> R.string.error_connect
                        NetProblem.TIMEOUT -> R.string.error_timeout
                        NetProblem.TLS -> R.string.error_tls
                        NetProblem.OTHER -> R.string.error_other
                    },
                )
                val parts = mutableListOf(base)
                // Zonder "http://" ervoor hebben we https geprobeerd. Lukt dat niet, dan is dit vaak de reden.
                if (target.schemeAssumed && result.problem != NetProblem.UNKNOWN_HOST) parts.add(getString(R.string.error_try_http))
                val couldBeBlocked = localNetworkPermissionMissing() && result.problem != NetProblem.UNKNOWN_HOST && result.problem != NetProblem.TLS
                if (couldBeBlocked) parts.add(getString(R.string.local_network_hint))
                fail(parts.joinToString("\n\n"), offerGrant = couldBeBlocked)
            }
        }
    }

    private fun fail(message: String, offerGrant: Boolean = false) {
        setBusy(false)
        showError(message, offerGrant = offerGrant)
    }

    // ---------- toegang tot het thuisnetwerk (Android 17 en nieuwer) ----------

    private fun localNetworkPermissionMissing(): Boolean =
        Build.VERSION.SDK_INT >= SyncWorker.API_LOCAL_NETWORK &&
            ContextCompat.checkSelfPermission(this, SyncWorker.PERMISSION_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED

    private fun askLocalNetwork(target: ServerAddress.Result.Ok) {
        AlertDialog.Builder(this)
            .setTitle(R.string.local_network_title)
            .setMessage(R.string.local_network_message)
            .setPositiveButton(R.string.local_network_continue) { _, _ -> requestLocalNetwork(target) }
            .setNegativeButton(R.string.cancel) { _, _ -> fail(getString(R.string.local_network_denied), offerGrant = true) }
            .setOnCancelListener { fail(getString(R.string.local_network_denied), offerGrant = true) }
            .show()
    }

    private fun requestLocalNetwork(target: ServerAddress.Result.Ok) {
        waitingForPermission = target
        localNetworkPermission.launch(SyncWorker.PERMISSION_LOCAL_NETWORK)
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (e: ActivityNotFoundException) {
            // geen instellingenscherm op dit toestel
        }
    }

    // ---------- het scherm ----------

    private fun updateHttpWarning() {
        val typed = address.text.toString().trim().lowercase()
        httpWarning.isVisible = typed.startsWith("http://")
    }

    private fun setBusy(busy: Boolean) {
        connect.isEnabled = !busy
        connect.alpha = if (busy) 0.6f else 1f
        connect.setText(if (busy) R.string.setup_connecting else R.string.setup_connect)
        address.isEnabled = !busy
        progress.isVisible = busy
    }

    private fun showError(message: String, offerGrant: Boolean = false, offerSettings: Boolean = false) {
        error.text = message
        error.isVisible = true
        grant.isVisible = offerGrant
        settings.isVisible = offerSettings
    }

    private fun hideError() {
        error.isVisible = false
        grant.isVisible = false
        settings.isVisible = false
    }

    companion object {
        /** Het vorige adres, om na "Serveradres wijzigen" alvast in te vullen. */
        const val EXTRA_PREVIOUS = "io.github.wnijhof.tickory.extra.PREVIOUS_ORIGIN"
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val READ_TIMEOUT_MS = 8_000
    }
}
