package io.github.wnijhof.tickory

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.DownloadResult
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.ShareLink
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ShareStore
import io.github.wnijhof.tickory.store.TokenVault
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Bijlagen op Android: een bijlage ophalen en aan een andere app geven, de bestandskiezer en de camera, en bestanden die een andere app
 * naar Tickory deelt. De WebView is hier een attrappe (zie ScreensTest); of een echte bestandskiezer of camera-app op een toestel goed
 * samenwerkt, is alleen daar te controleren.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class AttachmentsAndroidTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val originalExecutor: Executor = Background.executor
    private val token = "tky_test-token_0123456789"

    @Before
    fun setUp() {
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        // De echte FileProvider rekent met paden van het toestel; onder Robolectric op Windows vindt hij zijn eigen mappen niet terug. De
        // tests geven daarom een eigen adres per bestand, en controleren apart dat file_paths.xml alleen de twee juiste mappen bevat.
        AttachmentFiles.uriResolver = { context, file -> Uri.parse("content://${AttachmentFiles.authority(context)}/${file.parentFile?.parentFile?.name}/${file.parentFile?.name}/${file.name}") }
        ShareStore.clear(app)
        File(app.cacheDir, "attachments").deleteRecursively()
        File(app.cacheDir, "camera").deleteRecursively()
    }

    @After
    fun tearDown() {
        Background.executor = originalExecutor
        ShareStore.clear(app)
    }

    private fun main(origin: String, intent: Intent? = null): MainActivity {
        Prefs(app).setServer(origin, false)
        val controller = if (intent != null) Robolectric.buildActivity(MainActivity::class.java, intent) else Robolectric.buildActivity(MainActivity::class.java)
        return controller.setup().get()
    }

    private fun webViewOf(activity: MainActivity): WebView = activity.findViewById<ViewGroup>(R.id.web_container).getChildAt(0) as WebView

    private fun get(url: String, method: String = "GET") = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame(): Boolean = false
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = false
        override fun getMethod(): String = method
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private fun chooserParams(accept: Array<String> = arrayOf("*/*"), capture: Boolean = false) = object : WebChromeClient.FileChooserParams() {
        override fun getMode(): Int = MODE_OPEN_MULTIPLE
        override fun getAcceptTypes(): Array<String> = accept
        override fun isCaptureEnabled(): Boolean = capture
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }

    private fun serve(vararg files: Pair<String, String>): FakeServer = FakeServer { request ->
        val id = request.path.removePrefix("/api/v1/attachments/")
        val hit = files.firstOrNull { it.first == id }
        when {
            request.headers["authorization"] != "Bearer $token" -> Response(401, "{}")
            hit == null -> Response(404, """{"error_code":"NOT_FOUND","error":"deze bijlage bestaat niet"}""")
            else -> Response(200, hit.second, mapOf("Content-Type" to "application/octet-stream"))
        }
    }

    // ---------- ophalen ----------

    @Test
    fun `een bijlage ophalen schrijft het bestand en stuurt het token alleen in een header mee`() {
        serve("bijlage-00001" to "inhoud van het bestand").use { server ->
            val target = File(app.cacheDir, "attachments/x/bestand.txt")
            val result = ApiClient(server.origin, 5_000, 5_000, "Tickory-Test/1").downloadTo(token, "/api/v1/attachments/bijlage-00001", target, 1_000)
            assertEquals(DownloadResult.Ok(22), result)
            assertEquals("inhoud van het bestand", target.readText())
            val request = server.requests.single()
            assertEquals("Bearer $token", request.headers["authorization"])
            assertFalse("het token staat niet in het adres", request.path.contains(token))
            assertEquals("Tickory-Test/1", request.headers["user-agent"])
        }
    }

    @Test
    fun `ophalen - 401, 404, een fout van de server, te groot en geen verbinding laten geen half bestand achter`() {
        FakeServer { request ->
            when (request.path) {
                "/api/v1/attachments/geen-401" -> Response(401, "{}")
                "/api/v1/attachments/geen-404" -> Response(404, "{}")
                "/api/v1/attachments/fout-500" -> Response(500, "{}")
                else -> Response(200, "x".repeat(100))
            }
        }.use { server ->
            val client = ApiClient(server.origin, 5_000, 5_000)
            fun file() = File(app.cacheDir, "attachments/test/${System.nanoTime()}")
            val a = file(); assertEquals(DownloadResult.Unauthorized, client.downloadTo(token, "/api/v1/attachments/geen-401", a, 1_000)); assertFalse(a.exists())
            val b = file(); assertEquals(DownloadResult.NotFound, client.downloadTo(token, "/api/v1/attachments/geen-404", b, 1_000)); assertFalse(b.exists())
            val c = file(); assertEquals(DownloadResult.Failed(null, 500), client.downloadTo(token, "/api/v1/attachments/fout-500", c, 1_000)); assertFalse(c.exists())
            val d = file(); assertEquals(DownloadResult.TooLarge, client.downloadTo(token, "/api/v1/attachments/groot", d, 50)); assertFalse(d.exists())
        }
        val gone = File(app.cacheDir, "attachments/test/geen-verbinding")
        val result = ApiClient(FakeServer.closedPortOrigin(), 15_000, 3_000).downloadTo(token, "/api/v1/attachments/bijlage-00001", gone, 1_000)
        assertTrue(result.toString(), result is DownloadResult.Failed)
        assertFalse(gone.exists())
    }

    @Test
    fun `de naam van een bijlage kan nooit een pad zijn - elk bestand in een eigen map in de cache`() {
        serve("bijlage-00001" to "a", "bijlage-00002" to "b").use { server ->
            val one = AttachmentFiles.fetch(app, server.origin, token, "bijlage-00001", "../../etc/passwd", "text/plain") as AttachmentFiles.Outcome.Done
            val two = AttachmentFiles.fetch(app, server.origin, token, "bijlage-00002", "../../etc/passwd", "text/plain") as AttachmentFiles.Outcome.Done
            assertEquals("_.._etc_passwd", one.ready.name)
            val cache = File(app.cacheDir, "attachments").canonicalFile
            assertTrue(one.ready.file.canonicalPath.startsWith(cache.path))
            assertTrue(two.ready.file.canonicalPath.startsWith(cache.path))
            assertTrue("twee bijlagen met dezelfde naam komen elkaar niet in de weg", one.ready.file.parentFile != two.ready.file.parentFile)
            assertEquals("a", one.ready.file.readText())
            assertEquals("b", two.ready.file.readText())
            assertEquals("text/plain", one.ready.mime)
        }
    }

    @Test
    fun `een onbekend id, een onveilig id of een afgemeld token geeft de juiste uitkomst en laat niets achter`() {
        serve("bijlage-00001" to "a").use { server ->
            assertEquals(AttachmentFiles.Outcome.NotFound, AttachmentFiles.fetch(app, server.origin, token, "bestaat-niet-1", "x.txt", null))
            assertEquals(AttachmentFiles.Outcome.NotFound, AttachmentFiles.fetch(app, server.origin, token, "../x", "x.txt", null))
            assertEquals(AttachmentFiles.Outcome.NotFound, AttachmentFiles.fetch(app, server.origin, token, "a/b", "x.txt", null))
            assertEquals(AttachmentFiles.Outcome.SignedOut, AttachmentFiles.fetch(app, server.origin, "ander-token", "bijlage-00001", "x.txt", null))
            assertEquals("alleen de twee echte verzoeken kwamen aan", 2, server.requests.size)
        }
        assertTrue(File(app.cacheDir, "attachments").listFiles().orEmpty().all { it.listFiles().orEmpty().isEmpty() })
    }

    @Test
    fun `opruimen - oude bestanden in de cache gaan weg, nieuwe blijven, gedeelde bestanden altijd`() {
        val old = File(app.cacheDir, "attachments/oud/a.txt").apply { parentFile!!.mkdirs(); writeText("x") }
        val recent = File(app.cacheDir, "attachments/nieuw/b.txt").apply { parentFile!!.mkdirs(); writeText("x") }
        val photo = File(app.cacheDir, "camera/foto-1.jpg").apply { parentFile!!.mkdirs(); writeText("x") }
        val shared = File(app.cacheDir, "share/abc/0").apply { parentFile!!.mkdirs(); writeText("x") }
        old.parentFile!!.setLastModified(1_000)
        photo.setLastModified(1_000)
        AttachmentFiles.cleanCaches(app)
        assertFalse(old.exists())
        assertTrue(recent.exists())
        assertFalse(photo.exists())
        assertFalse(shared.exists())
    }

    // ---------- gedeelde bestanden ----------

    private fun register(uri: String, content: ByteArray): Uri {
        val parsed = Uri.parse(uri)
        shadowOf(app.contentResolver).registerInputStream(parsed, ByteArrayInputStream(content))
        return parsed
    }

    @Test
    fun `gedeelde bestanden worden gekopieerd onder een token, zonder hun eigen naam op schijf`() {
        val a = register("content://com.voorbeeld.galerij/foto/17", ByteArray(2000) { 7 })
        val b = register("content://com.voorbeeld.bestanden/doc/rekening%20maart.pdf", "pdf".toByteArray())
        val (token, files) = ShareStore.import(app, listOf(a, b))!!
        assertTrue(Regex("^[A-Za-z0-9_-]{16,64}$").matches(token))
        assertEquals(2, files.size)
        assertEquals(2000L, files[0].size)
        assertEquals(3L, files[1].size)
        val item = ShareStore.open(app, token, 1)!!
        assertEquals("pdf", item.file.readText())
        assertEquals("1", item.file.name)
        assertTrue(item.file.canonicalPath.startsWith(File(app.cacheDir, "share").canonicalPath))
        assertNull(ShareStore.open(app, token, 2))
        assertNull(ShareStore.open(app, "onbekend-token-aaaaaaaa", 0))
    }

    @Test
    fun `een gedeeld bestand dat niet te lezen of leeg is wordt overgeslagen, en zonder bestanden is er niets`() {
        val good = register("content://com.voorbeeld.galerij/foto/1", "abc".toByteArray())
        val empty = register("content://com.voorbeeld.galerij/foto/2", ByteArray(0))
        val unreadable = Uri.parse("content://com.voorbeeld.niet.geregistreerd/foto/3")
        val (_, files) = ShareStore.import(app, listOf(unreadable, empty, good))!!
        assertEquals(1, files.size)
        assertEquals(3L, files[0].size)
        assertNull(ShareStore.import(app, listOf(unreadable, empty)))
        assertNull(ShareStore.import(app, emptyList()))
    }

    @Test
    fun `een token geldt tien minuten en alles gaat weg bij opruimen`() {
        val uri = register("content://com.voorbeeld.galerij/foto/1", "abc".toByteArray())
        val now = 1_000_000L
        val (token, _) = ShareStore.import(app, listOf(uri), now)!!
        assertNotNull(ShareStore.open(app, token, 0, now + ShareStore.TTL_MS - 1))
        assertNull(ShareStore.open(app, token, 0, now + ShareStore.TTL_MS))
        assertFalse(File(app.cacheDir, "share/$token").exists())
        val again = register("content://com.voorbeeld.galerij/foto/2", "abc".toByteArray())
        val (token2, _) = ShareStore.import(app, listOf(again), now)!!
        ShareStore.clear(app)
        assertNull(ShareStore.open(app, token2, 0, now))
        assertFalse(File(app.cacheDir, "share").exists())
    }

    @Test
    fun `hooguit twintig gedeelde bestanden`() {
        val uris = (1..30).map { register("content://com.voorbeeld.galerij/foto/$it", "x$it".toByteArray()) }
        assertEquals(ShareLink.MAX_FILES, ShareStore.import(app, uris)!!.second.size)
    }

    private fun fragmentOf(url: String?): Map<String, Any?> {
        assertNotNull(url)
        val encoded = url!!.substringAfter("#share=")
        return Json.parseObject(String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8))!!
    }

    @Test
    fun `delen van meerdere bestanden opent de app met een fragment met token en bestanden, en de pagina kan ze ophalen`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val one = register("content://com.voorbeeld.galerij/foto/1", "eerste".toByteArray())
            val two = register("content://com.voorbeeld.galerij/foto/2", "tweede bestand".toByteArray())
            val intent = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(one, two))
                .putExtra(Intent.EXTRA_TEXT, "Kijk even naar deze foto's")
            val activity = main(server.origin, intent)
            val webView = webViewOf(activity)
            val loaded = shadowOf(webView).lastLoadedUrl!!
            assertTrue(loaded, loaded.startsWith("${server.origin}/#share="))
            val data = fragmentOf(loaded)
            assertEquals("Kijk even naar deze foto's", data["text"])
            val token = data["token"] as String
            @Suppress("UNCHECKED_CAST")
            val files = data["files"] as List<Map<String, Any?>>
            assertEquals(2, files.size)
            assertEquals(6.0, (files[0]["size"] as Number).toDouble(), 0.0)

            // de pagina haalt een bestand op bij de eigen server; de app beantwoordt dat zelf
            val client = shadowOf(webView).webViewClient
            val response = client.shouldInterceptRequest(webView, get("${server.origin}/__tickory_share/$token/1"))!!
            assertEquals(200, response.statusCode)
            assertEquals("no-store", response.responseHeaders["Cache-Control"])
            assertEquals("tweede bestand", String(response.data.readBytes()))
            assertEquals("tweede bestand".length.toString(), response.responseHeaders["Content-Length"])
            assertEquals("application/octet-stream", response.mimeType)

            for (nothing in listOf(
                "${server.origin}/__tickory_share/$token/2", "${server.origin}/__tickory_share/$token/x", "${server.origin}/__tickory_share/$token",
                "${server.origin}/__tickory_share/$token/0/extra", "${server.origin}/__tickory_share/onbekend-token-aaaaaaaa/0", "${server.origin}/__tickory_share//0",
            )) {
                assertEquals(nothing, 404, client.shouldInterceptRequest(webView, get(nothing))!!.statusCode)
            }
            assertEquals("alleen een GET", 404, client.shouldInterceptRequest(webView, get("${server.origin}/__tickory_share/$token/0", "POST"))!!.statusCode)
            assertNull("een ander adres dan de ingestelde server wordt niet bediend", client.shouldInterceptRequest(webView, get("https://kwaad.voorbeeld.org/__tickory_share/$token/0")))
            assertNull("andere verzoeken gaan gewoon door", client.shouldInterceptRequest(webView, get("${server.origin}/app.css")))
        }
    }

    @Test
    fun `delen van een bestand uit de eigen FileProvider of een file-adres wordt genegeerd`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val own = Uri.parse("content://${app.packageName}.files/attachments/x/geheim.txt")
            val path = Uri.parse("file:///data/data/geheim.txt")
            val activity = main(server.origin, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, own))
            assertEquals(server.origin + "/", shadowOf(webViewOf(activity)).lastLoadedUrl)
            val second = main(server.origin, Intent(Intent.ACTION_SEND).setType("*/*").putExtra(Intent.EXTRA_STREAM, path))
            assertEquals(server.origin + "/", shadowOf(webViewOf(second)).lastLoadedUrl)
        }
    }

    @Test
    fun `delen van tekst werkt zoals eerst, zonder bestanden`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://example.org/route"))
            val data = fragmentOf(shadowOf(webViewOf(activity)).lastLoadedUrl)
            assertEquals("https://example.org/route", data["text"])
            assertNull(data["files"])
            assertNull(data["token"])
        }
    }

    // ---------- openen en opslaan ----------

    @Test
    fun `de brug haalt een bijlage op en opent hem in een andere app, met een tijdelijk recht en een veilig type`() {
        serve("bijlage-00001" to "<html>geen echte pagina</html>").use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
            bridge.setSession(token)
            bridge.openAttachment("bijlage-00001", "uitleg.html", "text/html")
            val intent = shadowOf(activity).nextStartedActivity
            assertNotNull(intent)
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("html wordt aan de andere app als gewone tekst aangeboden", "text/plain", intent.type)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertEquals("content", intent.data?.scheme)
            assertEquals("${app.packageName}.files", intent.data?.authority)
            assertEquals("Bearer $token", server.requests.single().headers["authorization"])
        }
    }

    @Test
    fun `de brug doet niets voor een vreemde pagina, een onveilig id of zonder aanmelding`() {
        serve("bijlage-00001" to "a").use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
            bridge.openAttachment("bijlage-00001", "a.txt", "text/plain") // niet aangemeld
            assertNull(shadowOf(activity).nextStartedActivity)
            bridge.setSession(token)
            bridge.openAttachment("../etc", "a.txt", "text/plain")
            bridge.openAttachment(null, "a.txt", "text/plain")
            webView.loadUrl("https://kwaad.voorbeeld.org/")
            bridge.openAttachment("bijlage-00001", "a.txt", "text/plain")
            bridge.saveAttachment("bijlage-00001", "a.txt", "text/plain")
            assertNull(shadowOf(activity).nextStartedActivity)
            assertTrue("er is niets opgehaald", server.requests.isEmpty())
        }
    }

    @Test
    fun `opslaan - de gebruiker kiest waar, daarna wordt het bestand daarheen gekopieerd en de cache opgeruimd`() {
        serve("bijlage-00001" to "te bewaren inhoud").use { server ->
            val activity = main(server.origin)
            val bridge = shadowOf(webViewOf(activity)).getJavascriptInterface("TickoryAndroid") as WebBridge
            bridge.setSession(token)
            bridge.saveAttachment("bijlage-00001", "Rekening café.pdf", "application/pdf")
            val started = shadowOf(activity).peekNextStartedActivityForResult()
            assertEquals(Intent.ACTION_CREATE_DOCUMENT, started.intent.action)
            assertEquals("application/pdf", started.intent.type)
            assertEquals("Rekening café.pdf", started.intent.getStringExtra(Intent.EXTRA_TITLE))

            val destination = Uri.parse("content://com.voorbeeld.documenten/document/1")
            val written = ByteArrayOutputStream()
            shadowOf(app.contentResolver).registerOutputStream(destination, written)
            shadowOf(activity).receiveResult(started.intent, Activity.RESULT_OK, Intent().setData(destination))
            assertEquals("te bewaren inhoud", written.toString("UTF-8"))
            assertTrue("de tijdelijke kopie is weg", File(app.cacheDir, "attachments").listFiles().orEmpty().all { it.listFiles().orEmpty().isEmpty() })
        }
    }

    @Test
    fun `opslaan annuleren laat niets achter`() {
        serve("bijlage-00001" to "x").use { server ->
            val activity = main(server.origin)
            val bridge = shadowOf(webViewOf(activity)).getJavascriptInterface("TickoryAndroid") as WebBridge
            bridge.setSession(token)
            bridge.saveAttachment("bijlage-00001", "a.txt", "text/plain")
            val started = shadowOf(activity).peekNextStartedActivityForResult()
            shadowOf(activity).receiveResult(started.intent, Activity.RESULT_CANCELED, null)
            assertTrue(File(app.cacheDir, "attachments").listFiles().orEmpty().all { it.listFiles().orEmpty().isEmpty() })
        }
    }

    // ---------- de bestandskiezer en de camera ----------

    @Test
    fun `de bestandskiezer geeft de gekozen bestanden aan de pagina, en annuleren geeft null`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val chrome = shadowOf(webView).webChromeClient
            val results = ArrayList<Array<Uri>?>()
            val callback = ValueCallback<Array<Uri>> { results.add(it) }
            assertTrue(chrome.onShowFileChooser(webView, callback, chooserParams()))
            val started = shadowOf(activity).peekNextStartedActivityForResult()
            assertEquals(Intent.ACTION_CHOOSER, started.intent.action)
            val inner = started.intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
            assertEquals(Intent.ACTION_GET_CONTENT, inner.action)
            val picked = Uri.parse("content://com.voorbeeld.galerij/foto/1")
            shadowOf(activity).receiveResult(started.intent, Activity.RESULT_OK, Intent().setData(picked))
            assertEquals(1, results.size)
            assertEquals(picked, results[0]!!.single())

            // annuleren
            chrome.onShowFileChooser(webView, callback, chooserParams())
            shadowOf(activity).receiveResult(shadowOf(activity).peekNextStartedActivityForResult().intent, Activity.RESULT_CANCELED, null)
            assertEquals(2, results.size)
            assertNull(results[1])
        }
    }

    @Test
    fun `een tweede keuze beantwoordt de eerste met null, zodat de kiezer niet vastloopt`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val chrome = shadowOf(webView).webChromeClient
            val first = ArrayList<Array<Uri>?>()
            val second = ArrayList<Array<Uri>?>()
            chrome.onShowFileChooser(webView, { first.add(it) }, chooserParams())
            chrome.onShowFileChooser(webView, { second.add(it) }, chooserParams())
            assertEquals(listOf<Array<Uri>?>(null), first)
            assertTrue(second.isEmpty())
        }
    }

    @Test
    fun `een pagina van een andere site krijgt geen bestandskiezer`() {
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            webView.loadUrl("https://kwaad.voorbeeld.org/")
            val results = ArrayList<Array<Uri>?>()
            assertTrue(shadowOf(webView).webChromeClient.onShowFileChooser(webView, { results.add(it) }, chooserParams()))
            assertEquals(listOf<Array<Uri>?>(null), results)
            assertNull(shadowOf(activity).peekNextStartedActivityForResult())
        }
    }

    @Test
    fun `een foto van de camera gaat naar een eigen bestand in de cache en wordt aan de pagina gegeven`() {
        shadowOf(app.packageManager).addResolveInfoForIntent(Intent(MediaStore.ACTION_IMAGE_CAPTURE), android.content.pm.ResolveInfo().apply {
            activityInfo = android.content.pm.ActivityInfo().apply { packageName = "com.voorbeeld.camera"; name = "Camera"; applicationInfo = android.content.pm.ApplicationInfo().apply { packageName = "com.voorbeeld.camera" } }
        })
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val chrome = shadowOf(webView).webChromeClient
            val results = ArrayList<Array<Uri>?>()
            chrome.onShowFileChooser(webView, { results.add(it) }, chooserParams(arrayOf("image/*"), capture = true))
            val started = shadowOf(activity).peekNextStartedActivityForResult()
            assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, started.intent.action)
            val output = started.intent.getParcelableExtra<Uri>(MediaStore.EXTRA_OUTPUT)!!
            assertEquals("${app.packageName}.files", output.authority)
            assertTrue(started.intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
            // de camera-app schrijft de foto naar het bestand waar we om vroegen
            val photo = File(app.cacheDir, "camera/${output.lastPathSegment}")
            photo.parentFile!!.mkdirs()
            photo.writeBytes(byteArrayOf(1, 2, 3))
            shadowOf(activity).receiveResult(started.intent, Activity.RESULT_OK, null)
            assertEquals(output, results.single()!!.single())
        }
    }

    @Test
    fun `een camera die niets maakte of werd geannuleerd, geeft null en ruimt het lege bestand op`() {
        shadowOf(app.packageManager).addResolveInfoForIntent(Intent(MediaStore.ACTION_IMAGE_CAPTURE), android.content.pm.ResolveInfo().apply {
            activityInfo = android.content.pm.ActivityInfo().apply { packageName = "com.voorbeeld.camera"; name = "Camera"; applicationInfo = android.content.pm.ApplicationInfo().apply { packageName = "com.voorbeeld.camera" } }
        })
        FakeServer { Response(200, "{}") }.use { server ->
            val activity = main(server.origin)
            val webView = webViewOf(activity)
            val chrome = shadowOf(webView).webChromeClient
            val results = ArrayList<Array<Uri>?>()
            for (code in listOf(Activity.RESULT_CANCELED, Activity.RESULT_OK)) {
                chrome.onShowFileChooser(webView, { results.add(it) }, chooserParams(arrayOf("image/*"), capture = true))
                shadowOf(activity).receiveResult(shadowOf(activity).peekNextStartedActivityForResult().intent, code, null)
            }
            assertEquals(listOf<Array<Uri>?>(null, null), results)
            assertTrue(File(app.cacheDir, "camera").listFiles().orEmpty().isEmpty())
        }
    }

    @Test
    fun `de FileProvider geeft alleen de twee mappen van de app vrij en is niet exporteerbaar`() {
        val xml = File("src/main/res/xml/file_paths.xml").readText()
        assertEquals(listOf("attachments/", "camera/"), Regex("<cache-path[^>]*path=\"([^\"]*)\"").findAll(xml).map { it.groupValues[1] }.toList())
        assertFalse("geen files-path, external-path of root-path", Regex("<(files|external|root|external-files|external-cache|external-media)-path").containsMatchIn(xml))
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val provider = manifest.substringAfter("androidx.core.content.FileProvider").substringBefore("</provider>")
        assertTrue(provider.contains("android:exported=\"false\""))
        assertTrue(provider.contains("android:grantUriPermissions=\"true\""))
        assertTrue(provider.contains("\${applicationId}.files"))
    }
}
