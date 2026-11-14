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
import android.provider.MediaStore
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerController
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
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
import io.github.wnijhof.tickory.core.AttachmentName
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.ServerAddress
import io.github.wnijhof.tickory.core.ShareLink
import io.github.wnijhof.tickory.core.VoiceScript
import io.github.wnijhof.tickory.geo.GeoEngine
import io.github.wnijhof.tickory.geo.GeoPermissionFlow
import io.github.wnijhof.tickory.geo.GeoPermissions
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ShareStore
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.reminders.AlarmScheduler
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler
import io.github.wnijhof.tickory.sync.SyncWorker
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
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

    /** Wat de web-app na het laden moet openen (zie DeepLink: "task=<id>", "add…" of "share=<tekst>"), tot het kan. */
    private var pendingFragment: String? = null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        onNotificationPermissionResult(granted)
    }

    /** De toestemmingen voor locatie (herinneringen op een plek), met uitleg vooraf; zie GeoPermissionFlow. */
    private val geoFlow = GeoPermissionFlow(this, { notifyPageOfStatusChange() }, { runScript(it) })

    private val voiceInput = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val spoken = if (result.resultCode == RESULT_OK) result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() else null
        runScript(if (result.resultCode == RESULT_OK) VoiceScript.result(spoken) else VoiceScript.error("cancelled"))
    }
    // Bestanden kiezen voor een bijlage: de bestandskiezer van Android (galerij, bestanden) en de camera.
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var photoFile: File? = null
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        finishFileChooser(result.resultCode, result.data)
    }

    // Een bijlage opslaan: Android laat de gebruiker kiezen waar (geen toestemming voor opslag nodig).
    private var pendingSave: AttachmentFiles.Ready? = null
    private val saveDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        finishSave(result.resultCode, result.data?.data)
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

        // Bestanden uit een andere app (Delen naar Tickory): eerst naar de eigen cache kopiëren, dan pas laden. Het opruimen van wat een
        // vorige keer in de cache bleef staan, gebeurt dan vóór het kopiëren in dezelfde taak (anders kan het de nieuwe bestanden wissen).
        val streams = sharedStreams(intent)
        if (streams.isEmpty()) {
            val app = applicationContext
            Background.executor.execute { AttachmentFiles.cleanCaches(app) }
        } else {
            shareWithFiles(intent, streams, cleanFirst = true) { shared ->
                if (needsLocalNetworkPermission()) {
                    pendingFragment = shared
                    askLocalNetworkPermission()
                } else {
                    loadStart(shared)
                }
            }
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
        val streams = sharedStreams(intent)
        if (streams.isNotEmpty()) {
            shareWithFiles(intent, streams) { shared -> if (shared != null) openFragment(shared) }
            return
        }
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
            GeoEngine.refresh(app) // ook na terugkeer uit de instellingen, waar de locatietoestemming kan zijn veranderd
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
        // Standaardgedrag, zodat meldingen van de pagina (alert, confirm) werken; plus de bestandskiezer voor bijlagen.
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
                showFileChooser(webView, filePathCallback, fileChooserParams)
        }
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

    /** Laadt de web-app, eventueel meteen bij een taak, het venster Taak toevoegen of een gedeelde tekst (zie DeepLink). */
    private fun loadStart(fragment: String?) {
        val view = webView ?: return
        val target = (fragment ?: pendingFragment)?.takeIf(DeepLink::isSafe)
        pendingFragment = null
        hideError()
        pageReady = false
        view.loadUrl(if (target != null) "$origin/#$target" else "$origin/")
    }

    /** Opent een taak, Taak toevoegen of een gedeelde tekst. Staat de web-app al open, dan verandert alleen het fragment van het adres. */
    private fun openFragment(fragment: String) {
        if (!DeepLink.isSafe(fragment)) return
        val view = webView ?: return
        if (!pageReady || errorView.isVisible) {
            loadStart(fragment)
            return
        }
        // Het fragment bestaat alleen uit letters, cijfers, "-", "_" en "=" (DeepLink.isSafe, ook gecontroleerd in fragmentFrom), dus dit is veilig in te voegen.
        // Staat hetzelfde fragment er al, dan eerst leegmaken: anders merkt de web-app geen verandering op.
        val script = "(function(){var h='#$fragment';" +
            "if(location.hash===h){history.replaceState(null,'',location.pathname+location.search);}" +
            "location.hash=h;})();"
        view.evaluateJavascript(script, null)
    }

    /**
     * Wat deze intentie de web-app laat openen: een taak (melding of widget), het venster Taak toevoegen (de "+" van een
     * widget) of "Delen naar Tickory" met tekst uit een andere app. Een intentie die van buiten komt kan alleen tekst
     * meegeven; die gaat als base64url door ShareLink. Alles wat hier uitkomt, is door DeepLink.isSafe gekeurd.
     */
    private fun fragmentFrom(intent: Intent?): String? {
        if (intent == null) return null
        DeepLink.fromExtras(intent.getStringExtra(Notifications.EXTRA_TASK_ID), intent.hasExtra(DeepLink.EXTRA_ADD), intent.getStringExtra(DeepLink.EXTRA_ADD))?.let { return it }
        if (intent.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return null
        return ShareLink.fragmentFor(
            intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE),
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
        )?.takeIf(DeepLink::isSafe)
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

    fun notifyPageOfStatusChange() {
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
            if (!request.isForMainFrame) return sharedFileResponse(request)
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

    /**
     * Een bestand dat een andere app naar Tickory deelt, voor de pagina van de web-app: `/__tickory_share/<token>/<nummer>` op de
     * eigen server. Alleen een GET op het adres van de ingestelde server, met een token dat bij een recente deling hoort (zie
     * ShareStore); al het andere gaat gewoon verder. Draait op een achtergronddraad.
     */
    private fun sharedFileResponse(request: WebResourceRequest): WebResourceResponse? {
        val path = request.url.path ?: return null
        if (!path.startsWith(ShareStore.PATH_PREFIX) || !ServerAddress.sameOrigin(request.url.toString(), origin)) return null
        val headers = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        val missing = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        if (request.method != "GET") return missing
        val parts = path.removePrefix(ShareStore.PATH_PREFIX).split('/')
        val item = if (parts.size == 2) parts[1].toIntOrNull()?.let { ShareStore.open(applicationContext, parts[0], it) } else null
        item ?: return missing
        // Altijd als onbekend bestand: de pagina maakt er zelf een File van met de naam en het type uit het adres van de deling.
        return WebResourceResponse(AttachmentName.OCTET_STREAM, null, 200, "OK", headers + ("Content-Length" to item.size.toString()), FileInputStream(item.file))
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

    // ---------- bestanden kiezen, delen en opslaan (bijlagen) ----------

    /**
     * De bestandskiezer voor een `<input type="file">` van de web-app: de kiezer van Android (galerij, bestanden, andere apps) en, als
     * de pagina foto's toestaat, de camera. De camera schrijft naar een eigen bestand in de cache (via een FileProvider), dus Tickory
     * heeft geen toestemming voor camera of opslag nodig. De pagina krijgt altijd een antwoord, ook bij annuleren: anders blijft
     * de kiezer na de eerste keer dicht.
     */
    private fun showFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        photoFile?.delete()
        photoFile = null
        if (!ServerAddress.sameOrigin(view.url, origin)) {
            callback.onReceiveValue(null)
            return true
        }
        val camera = cameraIntent()
        val wantsPhoto = params.acceptTypes.isEmpty() || params.acceptTypes.all { it.isEmpty() } || params.acceptTypes.any { it.startsWith("image/") || it == "*/*" }
        val intent = if (params.isCaptureEnabled && camera != null) {
            camera
        } else {
            Intent(Intent.ACTION_CHOOSER)
                .putExtra(Intent.EXTRA_INTENT, params.createIntent())
                .also { if (camera != null && wantsPhoto) it.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera)) }
        }
        fileCallback = callback
        try {
            fileChooser.launch(intent)
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            callback.onReceiveValue(null)
        }
        return true
    }

    private fun cameraIntent(): Intent? {
        val file = AttachmentFiles.newPhotoFile(this)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, AttachmentFiles.uriFor(this, file))
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (intent.resolveActivity(packageManager) == null) return null
        photoFile = file
        return intent
    }

    private fun finishFileChooser(resultCode: Int, data: Intent?) {
        val callback = fileCallback ?: return
        fileCallback = null
        val photo = photoFile
        photoFile = null
        var uris: Array<Uri>? = if (resultCode == RESULT_OK) chosenUris(data) else null
        if (resultCode == RESULT_OK && uris == null && photo != null && photo.length() > 0) {
            uris = arrayOf(AttachmentFiles.uriFor(this, photo)) // de camera geeft niets terug, maar schreef naar ons bestand
        } else if (photo != null) {
            photo.delete()
        }
        callback.onReceiveValue(uris)
    }

    /** De adressen die de bestandskiezer teruggaf (één bestand of er meer), of null als er niets gekozen is. */
    private fun chosenUris(data: Intent?): Array<Uri>? {
        if (data == null) return null
        val clip = data.clipData
        val fromClip = if (clip != null) (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } else emptyList()
        val all = fromClip.ifEmpty { listOfNotNull(data.data) }
        return if (all.isEmpty()) null else all.toTypedArray()
    }

    /** De bestanden die een andere app deelt (ACTION_SEND of ACTION_SEND_MULTIPLE), of een lege lijst. Alleen content://-adressen. */
    private fun sharedStreams(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        val uris = ArrayList<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> {
                val one = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                }
                if (one != null) uris.add(one)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val many = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                }
                if (many != null) uris.addAll(many.filterNotNull())
            }
            else -> return emptyList()
        }
        // Geen file://-adressen (paden op het toestel) en nooit onze eigen FileProvider: alleen wat een andere app echt aanbiedt.
        return uris.filter { it.scheme == "content" && it.authority != AttachmentFiles.authority(this) }
    }

    /** Kopieert de gedeelde bestanden naar de cache en geeft daarna het fragment voor de web-app (op de hoofddraad). */
    private fun shareWithFiles(intent: Intent, uris: List<Uri>, cleanFirst: Boolean = false, then: (String?) -> Unit) {
        val app = applicationContext
        val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE)
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
        Toast.makeText(this, R.string.share_copying, Toast.LENGTH_SHORT).show()
        Background.executor.execute {
            if (cleanFirst) AttachmentFiles.cleanCaches(app)
            val imported = ShareStore.import(app, uris)
            val fragment = ShareLink.fragmentFor(subject, text, imported?.second ?: emptyList(), imported?.first)?.takeIf(DeepLink::isSafe)
            runOnUiThread { if (!isFinishing && !isDestroyed) then(fragment) }
        }
    }

    /**
     * "Openen" (in een andere app) of "Opslaan" (op een plek naar keuze) van een bijlage, aangeroepen vanuit de brug. De app haalt
     * het bestand zelf op, met het token uit de Keystore.
     */
    fun transferAttachment(id: String, name: String?, mime: String?, save: Boolean) {
        if (!Ids.isSafeId(id)) return
        val app = applicationContext
        val server = origin
        Toast.makeText(this, R.string.attachment_fetching, Toast.LENGTH_SHORT).show()
        Background.executor.execute {
            val token = TokenVault.load(app)
            val outcome = if (token == null) AttachmentFiles.Outcome.SignedOut else AttachmentFiles.fetch(app, server, token, id, name, mime)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                when (outcome) {
                    is AttachmentFiles.Outcome.Done -> if (save) saveToDevice(outcome.ready) else viewFile(outcome.ready)
                    AttachmentFiles.Outcome.SignedOut -> Toast.makeText(this, R.string.attachment_signed_out, Toast.LENGTH_LONG).show()
                    AttachmentFiles.Outcome.NotFound -> Toast.makeText(this, R.string.attachment_not_found, Toast.LENGTH_LONG).show()
                    AttachmentFiles.Outcome.TooLarge -> Toast.makeText(this, R.string.attachment_too_large, Toast.LENGTH_LONG).show()
                    AttachmentFiles.Outcome.Failed -> Toast.makeText(this, R.string.attachment_failed, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun viewFile(ready: AttachmentFiles.Ready) {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(AttachmentFiles.uriFor(this, ready.file), AttachmentName.viewMime(ready.mime))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.attachment_no_app, Toast.LENGTH_LONG).show()
        }
    }

    private fun saveToDevice(ready: AttachmentFiles.Ready) {
        pendingSave?.file?.parentFile?.deleteRecursively()
        pendingSave = ready
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(AttachmentName.mime(ready.mime))
            .putExtra(Intent.EXTRA_TITLE, ready.name)
        try {
            saveDocument.launch(intent)
        } catch (e: ActivityNotFoundException) {
            pendingSave = null
            ready.file.parentFile?.deleteRecursively()
            Toast.makeText(this, R.string.attachment_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun finishSave(resultCode: Int, target: Uri?) {
        val ready = pendingSave ?: return
        pendingSave = null
        if (resultCode != RESULT_OK || target == null) {
            ready.file.parentFile?.deleteRecursively()
            return
        }
        Background.executor.execute {
            val saved = try {
                contentResolver.openOutputStream(target)?.use { out -> ready.file.inputStream().use { it.copyTo(out) } } != null
            } catch (e: java.io.IOException) {
                false
            } catch (e: RuntimeException) {
                false
            }
            ready.file.parentFile?.deleteRecursively()
            runOnUiThread { Toast.makeText(this, if (saved) R.string.attachment_saved else R.string.attachment_save_failed, Toast.LENGTH_LONG).show() }
        }
    }

    // ---------- spraakinvoer ----------

    private fun speechIntent(language: String?): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (language == "en") "en-US" else "nl-NL")
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

    fun hasSpeechRecognizer(): Boolean = speechIntent(null).resolveActivity(packageManager) != null

    /** Opent de spraakherkenner van het toestel (gewoon een scherm van Android; de microfoon is van dat scherm, niet van Tickory). */
    fun startVoiceInput(language: String?) {
        if (!hasSpeechRecognizer()) {
            runScript(VoiceScript.error("unavailable"))
            return
        }
        try {
            voiceInput.launch(speechIntent(language))
        } catch (_: ActivityNotFoundException) {
            runScript(VoiceScript.error("unavailable"))
        }
    }

    /** Een stukje JavaScript in de web-app uitvoeren; alleen scripts uit [VoiceScript], die al hun tekst ontsnappen. */
    private fun runScript(script: String) {
        if (pageReady) webView?.evaluateJavascript(script, null)
    }

    // ---------- locatie: herinneringen op een plek (aangeroepen vanuit de brug, op de hoofddraad) ----------

    /** De gebruiker wil herinneringen op een plek: uitleg, dan de toestemmingen (zie GeoPermissionFlow). */
    fun requestLocationPermission() = geoFlow.start()

    /** De instellingen van het toestel (als locatie uit staat) of van de app (voor de toestemming). */
    fun openLocationSettings() = geoFlow.openLocationSettings(servicesOff = !GeoPermissions.servicesOn(this))

    /** Eén keer de positie bepalen voor "Gebruik mijn huidige positie"; het antwoord gaat als gebeurtenis naar de pagina. */
    fun requestCurrentPosition() = geoFlow.requestCurrentPosition()

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
