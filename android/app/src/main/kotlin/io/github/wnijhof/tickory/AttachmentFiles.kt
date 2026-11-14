package io.github.wnijhof.tickory

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.AttachmentName
import io.github.wnijhof.tickory.core.DownloadResult
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.store.ShareStore
import io.github.wnijhof.tickory.sync.Session
import java.io.File
import java.security.SecureRandom

/**
 * Een bijlage van de server ophalen voor "Openen" of "Opslaan" in de Android-app. De browser in de WebView kan een bestand uit
 * een blob-URL niet aan een andere app geven, en een download met het sessietoken lukt de downloadmanager niet; daarom haalt
 * de app het bestand zelf op (met het token uit de Keystore, zoals de achtergrondverversing) en geeft het via een FileProvider
 * aan de andere app. De bestanden staan in de cache onder een willekeurige map en worden na een dag opgeruimd.
 */
object AttachmentFiles {
    private const val DIR = "attachments"
    private const val CAMERA_DIR = "camera"
    private const val MAX_BYTES = 500L * 1024 * 1024
    private const val KEEP_MS = 24 * 60 * 60 * 1000L

    class Ready(val file: File, val name: String, val mime: String)

    sealed class Outcome {
        class Done(val ready: Ready) : Outcome()
        object SignedOut : Outcome()
        object NotFound : Outcome()
        object TooLarge : Outcome()
        object Failed : Outcome()
    }

    fun authority(context: Context): String = "${context.packageName}.files"

    /** Het adres waarmee een andere app (of de camera) dit bestand mag lezen of schrijven; voor tests te vervangen. */
    @Volatile
    var uriResolver: (Context, File) -> Uri = { context, file -> FileProvider.getUriForFile(context, authority(context), file) }

    fun uriFor(context: Context, file: File): Uri = uriResolver(context, file)

    /** Een nieuw, nog niet bestaand bestand voor een foto van de camera. */
    fun newPhotoFile(context: Context, now: Long = System.currentTimeMillis()): File {
        val dir = File(context.cacheDir, CAMERA_DIR)
        dir.mkdirs()
        return File(dir, "foto-$now.jpg")
    }

    /** Haalt de bijlage op. Duurt even: niet op de hoofddraad aanroepen. */
    fun fetch(
        context: Context,
        origin: String,
        token: String,
        id: String,
        name: String?,
        mime: String?,
        client: ApiClient = ApiClient(origin, readTimeoutMs = 60_000, userAgent = Session.userAgent),
    ): Outcome {
        if (!Ids.isSafeId(id)) return Outcome.NotFound
        val clean = AttachmentName.clean(name)
        // een willekeurige map per bestand: twee bijlagen met dezelfde naam komen elkaar niet in de weg, en de naam zelf is nooit een pad
        val folder = File(File(context.cacheDir, DIR), randomName())
        val target = File(folder, clean)
        return when (val result = client.downloadTo(token, "/api/v1/attachments/$id", target, MAX_BYTES)) {
            is DownloadResult.Ok -> Outcome.Done(Ready(target, clean, AttachmentName.mime(mime)))
            DownloadResult.Unauthorized -> {
                folder.deleteRecursively()
                Outcome.SignedOut
            }
            DownloadResult.NotFound -> {
                folder.deleteRecursively()
                Outcome.NotFound
            }
            DownloadResult.TooLarge -> {
                folder.deleteRecursively()
                Outcome.TooLarge
            }
            is DownloadResult.Failed -> {
                folder.deleteRecursively()
                Outcome.Failed
            }
        }
    }

    /** Het grootste tekstbestand dat de web-app via de brug laat opslaan (een export van al je taken). */
    const val MAX_TEXT_CHARS = 50_000_000

    /**
     * Zet tekst (bijvoorbeeld een export) als bestand klaar in de cache, in een eigen willekeurige map, om het via het
     * opslaan-scherm van Android op een plek naar keuze te bewaren. De naam is nooit een pad; te grote tekst geeft null.
     */
    fun prepareText(context: Context, name: String?, mime: String?, text: String?): Ready? {
        if (text == null || text.length > MAX_TEXT_CHARS) return null
        val clean = AttachmentName.clean(name)
        val folder = File(File(context.cacheDir, DIR), randomName())
        val target = File(folder, clean)
        return try {
            folder.mkdirs()
            target.writeText(text, Charsets.UTF_8)
            Ready(target, clean, AttachmentName.mime(mime))
        } catch (e: java.io.IOException) {
            folder.deleteRecursively()
            null
        }
    }

    private fun randomName(): String {
        val bytes = ByteArray(8)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * Ruimt op wat in de cache is achtergebleven: opgehaalde bijlagen en foto's ouder dan een dag, en alle gedeelde bestanden
     * (hun tokens leven alleen in het geheugen). Bij het opstarten, op een achtergronddraad.
     */
    fun cleanCaches(context: Context, now: Long = System.currentTimeMillis()) {
        for (name in listOf(DIR, CAMERA_DIR)) {
            File(context.cacheDir, name).listFiles()?.forEach { entry ->
                if (now - entry.lastModified() > KEEP_MS) entry.deleteRecursively()
            }
        }
        ShareStore.clear(context)
    }
}
