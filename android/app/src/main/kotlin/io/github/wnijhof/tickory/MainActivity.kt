package io.github.wnijhof.tickory

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerController
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isInvisible
import androidx.core.view.isVisible
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.ServerAddress
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.reminders.AlarmScheduler
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler
import io.github.wnijhof.tickory.sync.SyncWorker
import java.io.ByteArrayInputStream
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * Het hoofdscherm: de web-app van de eigen server in een WebView. De app zelf voegt daar de herinneringen aan toe
 * (zie het pakket reminders) en de brug [WebBridge].
 */
class MainActivity : ComponentActivity() {
    private lateinit var prefs: Prefs

    /** De oorsprong van de ingestelde server. Ook gelezen vanaf de draden van de WebView en de brug, vandaar @Volatile. */
    @Volatile
    private var origin: String = ""
    private var webView: WebView? = null
    private lateinit var webContainer: FrameLayout
    private lateinit var errorView: View

    /** De hoofdpagina van deze laadbeurt is mislukt; onPageFinished komt daarna nog, maar telt dan niet als geslaagd. */
    private var mainFrameFailed = false

    /** De web-app is geladen en kan een taak openen via het fragment (#task=…). */
    private var pageReady = false

    private var notificationRationaleBefore = false
    private var localNetworkAsked = false

    /** Waar een melding of widget naartoe wil (zie DeepLink), als de app eerst nog iets moet vragen voordat hij kan laden. */
    private var pendingFragment: String? = null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        onNotificationPermissionResult(granted)
    }

    private val localNetworkPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            SyncScheduler.refreshNow(applicationContext)
            loadStart(null)
        } else {
            showError(getString(R.string.local_network_denied), offerSettings = true)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val saved = prefs.serverOrigin
        if (saved == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        origin = saved

        setContentView(R.layout.activity_main)
        webContainer = findViewById(R.id.web_container)
        errorView = findViewById(R.id.error_view)
        applySystemBarPadding(findViewById(R.id.root))

        findViewById<Button>(R.id.error_retry).setOnClickListener { loadStart(null) }
        findViewById<Button>(R.id.error_change_server).setOnClickListener { confirmChangeServer() }
        findViewById<Button>(R.id.error_grant).setOnClickListener { requestLocalNetworkPermission() }
        findViewById<Button>(R.id.error_settings).setOnClickListener { openAppSettings() }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val view = webView
                    // Eerst terug binnen de web-app; kan dat niet, dan gaat de app naar de achtergrond (en blijft dus open staan).
                    if (view != null && !errorView.isVisible && view.canGoBack()) view.goBack() else moveTaskToBack(true)
                }
            },
        )

        if (prefs.cleartextToInternet) {
            // Een eerder ingesteld http-adres naar een server buiten het eigen netwerk: niet laden, wel het adres kunnen wijzigen.
            showError(getString(R.string.error_http_not_local_saved), canRetry = false)
            return
        }

        if (!createWebView()) {
            showError(getString(R.string.webview_missing), canRetry = false)
            return
        }

        val fragment = fragmentFrom(intent)
        if (needsLocalNetworkPermission()) {
            // Zonder deze toestemming loopt elk verzoek naar een server op het thuisnetwerk dood: eerst vragen, dan laden.
            pendingFragment = fragment
            askLocalNetworkPermission()
        } else {
            loadStart(fragment)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val fragment = fragmentFrom(intent) ?: return
        openFragment(fragment)
    }

    override fun onStart() {
        super.onStart()
        webView?.onResume()
        if (origin.isEmpty()) return
        // De app komt naar voren: alarmen nalopen (ook zonder internet) en de gegevens verversen.
        val app = applicationContext
        Background.executor.execute {
            ReminderEngine.replan(app)
            if (Session.isActive(app)) SyncScheduler.refreshNow(app)
        }
    }

    override fun onResume() {
        super.onResume()
        // Terug van een toestemmingsvraag of een instellingenscherm: de web-app kan de status opnieuw opvragen.
        notifyPageOfStatusChange()
    }

    override fun onStop() {
        webView?.onPause()
        super.onStop()
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }

    // ---------- de WebView ----------

    /** @return false als Android geen WebView kan leveren (onderdeel ontbreekt, staat uit of wordt net bijgewerkt) */
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): Boolean {
        val view = try {
            WebView(this)
        } catch (e: RuntimeException) {
            return false
        }
        view.settings.apply {
            javaScriptEnabled = true // de web-app is een JavaScript-app; de WebView laadt alleen de eigen server
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = false // geen controle van adressen bij Google: de enige site is de eigen server
            // De web-app volgt de lettergrootte die in Android is ingesteld.
            textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(50, 250)
        }
        // Geen cookies van derden (de web-app gebruikt zelf geen cookies).
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        // De service worker van de web-app (bewaart de app voor gebruik zonder verbinding) mag draaien, met dezelfde beperkingen.
        try {
            ServiceWorkerController.getInstance().serviceWorkerWebSettings.apply {
                allowFileAccess = false
                allowContentAccess = false
                blockNetworkLoads = false
            }
        } catch (e: RuntimeException) {
            // Een WebView zonder ondersteuning voor service workers: de app werkt dan gewoon, alleen niet zonder verbinding.
        }
        view.setBackgroundColor(ContextCompat.getColor(this, R.color.background))
        view.webViewClient = Client()
        view.webChromeClient = WebChromeClient() // standaardgedrag, zodat meldingen van de pagina (alert, confirm) werken
        view.addJavascriptInterface(WebBridge(this), WebBridge.NAME)

        webContainer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        return true
    }

    private fun destroyWebView() {
        val view = webView ?: return
        webView = null
        pageReady = false
        (view.parent as? ViewGroup)?.removeView(view)
        view.removeJavascriptInterface(WebBridge.NAME)
        view.destroy()
    }

    /** Laadt de web-app, eventueel meteen bij een taak of het venster Taak toevoegen (zie DeepLink). */
    private fun loadStart(fragment: String?) {
        val view = webView ?: return
        val target = fragment ?: pendingFragment
        pendingFragment = null
        hideError()
        pageReady = false
        view.loadUrl(if (target != null) "$origin/#$target" else "$origin/")
    }

    /** Opent een taak of Taak toevoegen (vanuit een melding of widget). Staat de web-app al open, dan verandert alleen het fragment van het adres. */
    private fun openFragment(fragment: String) {
        val view = webView ?: return
        if (!pageReady || errorView.isVisible) {
            loadStart(fragment)
            return
        }
        // Het fragment bestaat alleen uit letters, cijfers, "-", "_" en "=" (gebouwd door DeepLink), dus dit is veilig in te voegen.
        // Staat hetzelfde fragment er al, dan eerst leegmaken: anders merkt de web-app geen verandering op.
        val script = "(function(){var h='#$fragment';" +
            "if(location.hash===h){history.replaceState(null,'',location.pathname+location.search);}" +
            "location.hash=h;})();"
        view.evaluateJavascript(script, null)
    }

    private fun fragmentFrom(intent: Intent?): String? = intent?.let {
        DeepLink.fromExtras(it.getStringExtra(Notifications.EXTRA_TASK_ID), it.hasExtra(DeepLink.EXTRA_ADD), it.getStringExtra(DeepLink.EXTRA_ADD))
    }

    /**
     * Hoort de pagina die nu geladen is bij de ingestelde server? De brug vraagt dit bij elke aanroep. Wordt op de
     * draad van de brug aangeroepen; het adres van de WebView mag alleen op de hoofddraad gelezen worden, dus we
     * vragen het daar op en wachten op het antwoord. Komt dat er niet (de hoofddraad zit vast of het scherm is weg),
     * dan is het antwoord "nee". De wachttijd is ruim: een onterecht "nee" zou betekenen dat de aanmelding niet
     * aankomt en er geen herinneringen komen.
     */
    fun isTrustedPage(): Boolean {
        val task = FutureTask { webView?.url }
        runOnUiThread(task)
        val url = try {
            task.get(10, TimeUnit.SECONDS)
        } catch (e: Exception) {
            null
        }
        return ServerAddress.sameOrigin(url, origin)
    }

    private fun notifyPageOfStatusChange() {
        val view = webView ?: return
        if (!pageReady || !ServerAddress.sameOrigin(view.url, origin)) return
        view.evaluateJavascript("window.dispatchEvent(new Event('tickory-android-status'));", null)
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (ServerAddress.sameOrigin(request.url.toString(), origin)) return false
            // Alles buiten de eigen server laadt nooit in de app. Een link waar de gebruiker op tikt, gaat naar de browser.
            if (request.isForMainFrame) {
                if (request.hasGesture()) {
                    openExternally(request.url)
                } else if (!pageReady) {
                    // De server stuurt de app bij het openen zelf door naar een ander adres (bijvoorbeeld een inlogpagina
                    // van een tussenliggende dienst). Dat volgen we niet; wel zeggen we wat er aan de hand is.
                    mainFrameFailed = true
                    val target = ServerAddress.originOf(request.url.toString()) ?: request.url.host ?: request.url.toString()
                    showError(getString(R.string.load_error_redirect, target))
                }
            }
            return true
        }

        /**
         * Tweede slot op dezelfde deur. shouldOverrideUrlLoading wordt niet aangeroepen voor een formulier dat met
         * POST naar een ander adres gaat; dit wel, voor elk verzoek. Een hele pagina (hoofdkader) van buiten de eigen
         * server krijgt hier een leeg antwoord en laadt dus nooit in de app. Draait op een achtergronddraad.
         */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (!request.isForMainFrame) return null
            val scheme = request.url.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null // about:, data:, blob: horen bij de pagina zelf
            if (ServerAddress.sameOrigin(request.url.toString(), origin)) return null
            return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            mainFrameFailed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (mainFrameFailed) return
            if (ServerAddress.sameOrigin(url, origin)) {
                pageReady = true
                hideError()
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            showError(getString(R.string.load_error_message, origin), offerLocalNetwork = true)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            showError(getString(R.string.load_error_http, origin, errorResponse.statusCode))
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel() // bij een certificaatfout gaan we nooit door
            if (ServerAddress.sameOrigin(error.url, origin)) {
                mainFrameFailed = true
                showError(getString(R.string.load_error_tls, origin))
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Android heeft het proces van de WebView beëindigd (meestal geheugengebrek). Niet mee laten crashen: opnieuw opbouwen.
            destroyWebView()
            recreate()
            return true
        }
    }

    private fun openExternally(uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_LONG).show()
        }
    }

    // ---------- het eigen foutscherm ----------

    private fun showError(message: String, canRetry: Boolean = true, offerLocalNetwork: Boolean = false, offerSettings: Boolean = false) {
        pageReady = false
        findViewById<TextView>(R.id.error_message).text = message
        findViewById<View>(R.id.error_retry).isVisible = canRetry
        val missingLocal = offerLocalNetwork && localNetworkPermissionMissing()
        findViewById<View>(R.id.error_hint).isVisible = missingLocal
        findViewById<View>(R.id.error_grant).isVisible = missingLocal
        findViewById<View>(R.id.error_settings).isVisible = offerSettings
        errorView.isVisible = true
        webView?.isInvisible = true
    }

    private fun hideError() {
        errorView.isVisible = false
        webView?.isInvisible = false
    }

    // ---------- systeembalken ----------

    /**
     * De app tekent tot onder de systeembalken (verplicht vanaf Android 15). De inhoud krijgt daarom zelf ruimte voor
     * de statusbalk, de navigatiebalk, een uitsparing in het scherm en het toetsenbord; de achtergrond loopt wel door.
     */
    private fun applySystemBarPadding(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    // ---------- toestemmingen en instellingen (aangeroepen vanuit de brug, op de hoofddraad) ----------

    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationRationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            openNotificationSettings() // uitgezet in de instellingen: daar is het ook weer aan te zetten
            return
        }
        requestExactAlarmsIfNeeded()
    }

    private fun onNotificationPermissionResult(granted: Boolean) {
        if (granted) {
            val app = applicationContext
            Background.executor.execute { ReminderEngine.replan(app) }
            requestExactAlarmsIfNeeded()
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !notificationRationaleBefore && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            // Android heeft de vraag niet (meer) getoond, omdat die al twee keer is afgewezen. Dan kan het alleen nog via de instellingen.
            openNotificationSettings()
        }
        notifyPageOfStatusChange()
    }

    /** Alleen Android 12 en 12L: daar kan de gebruiker exacte alarmen uitzetten. Nieuwere versies geven de app dit recht vast. */
    private fun requestExactAlarmsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || AlarmScheduler.canScheduleExact(this)) return
        startSettings(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.fromParts("package", packageName, null)))
    }

    fun openNotificationSettings() {
        startSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    /**
     * Opent de pagina van deze app in de instellingen van Android; daar staat "Batterij" (kies "Onbeperkt"). Bewust
     * niet de directe vraag "batterijoptimalisatie negeren": die vraagt een extra recht in het manifest.
     */
    fun openBatterySettings() {
        openAppSettings()
    }

    private fun openAppSettings() {
        startSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun startSettings(intent: Intent) {
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_SETTINGS))
            } catch (e2: ActivityNotFoundException) {
                // geen instellingenscherm op dit toestel
            }
        }
    }

    // ---------- toegang tot het thuisnetwerk (Android 17 en nieuwer) ----------

    private fun localNetworkPermissionMissing(): Boolean =
        Build.VERSION.SDK_INT >= SyncWorker.API_LOCAL_NETWORK &&
            ContextCompat.checkSelfPermission(this, SyncWorker.PERMISSION_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED

    private fun needsLocalNetworkPermission(): Boolean = prefs.serverIsLocal && localNetworkPermissionMissing() && !localNetworkAsked

    private fun askLocalNetworkPermission() {
        localNetworkAsked = true
        AlertDialog.Builder(this)
            .setTitle(R.string.local_network_title)
            .setMessage(R.string.local_network_message)
            .setPositiveButton(R.string.local_network_continue) { _, _ -> requestLocalNetworkPermission() }
            .setNegativeButton(R.string.cancel) { _, _ -> loadStart(null) }
            .setOnCancelListener { loadStart(null) }
            .show()
    }

    private fun requestLocalNetworkPermission() {
        localNetworkAsked = true
        localNetworkPermission.launch(SyncWorker.PERMISSION_LOCAL_NETWORK)
    }

    // ---------- ander serveradres ----------

    fun confirmChangeServer() {
        AlertDialog.Builder(this)
            .setTitle(R.string.change_server_title)
            .setMessage(R.string.change_server_message)
            .setPositiveButton(R.string.change_server_confirm) { _, _ -> changeServer() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun changeServer() {
        val previous = origin
        Session.signOut(applicationContext)
        // Ook wat de web-app van de oude server op dit toestel bewaarde (aanmelding, gegevens voor gebruik zonder verbinding).
        webView?.apply {
            stopLoading()
            clearHistory()
            clearCache(true)
        }
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies(null)
        prefs.clearServer()
        origin = ""
        startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_PREVIOUS, previous))
        finish()
    }
}
