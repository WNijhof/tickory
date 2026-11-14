package io.github.wnijhof.tickory.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Waarom een verzoek de server niet bereikte. */
enum class NetProblem { UNKNOWN_HOST, CONNECT, TIMEOUT, TLS, OTHER }

sealed class HealthResult {
    /** GET /health gaf {"ok":true}: hier draait de server. */
    object Ok : HealthResult()

    /** De server stuurt door naar een ander adres ([location] is de Location-header, kan ontbreken). */
    data class Redirect(val location: String?) : HealthResult()

    /** Er antwoordt wel iets, maar niet onze server. */
    data class NotTickory(val status: Int) : HealthResult()

    data class Unreachable(val problem: NetProblem) : HealthResult()
}

sealed class FetchResult {
    /** @property widget wat de widgets nodig hebben uit hetzelfde antwoord; null als dat niet te lezen was */
    data class Ok(val snapshot: SyncSnapshot, val widget: WidgetSnapshot? = null) : FetchResult()

    /** 401: de sessie is verlopen of ingetrokken. */
    object Unauthorized : FetchResult()

    /** Geen verbinding, of een antwoord waar we niets mee kunnen. Later opnieuw proberen. */
    data class Failed(val problem: NetProblem?, val status: Int) : FetchResult()
}

sealed class CompleteResult {
    object Done : CompleteResult()

    /** De server heeft het commando geweigerd; opnieuw proberen heeft geen zin. */
    data class Rejected(val code: String, val message: String) : CompleteResult()

    object Unauthorized : CompleteResult()

    /** Geen verbinding of een tijdelijke fout: opnieuw proberen met hetzelfde uuid. */
    data class Failed(val problem: NetProblem?, val status: Int) : CompleteResult()
}

/** De uitkomst van een rij commando's in één verzoek. */
sealed class BatchResult {
    /** De server antwoordde; per uuid de uitkomst (ontbreekt een uuid, dan is die [CommandStatus.Missing]). */
    data class Done(val statuses: Map<String, CommandStatus>) : BatchResult()

    object Unauthorized : BatchResult()

    /** De server weigert het hele verzoek; opnieuw sturen verandert niets. */
    data class Rejected(val code: String) : BatchResult()

    /** Geen verbinding of een tijdelijke fout: opnieuw proberen. */
    object Failed : BatchResult()
}

/** De uitkomst van het ophalen van een bijlage naar een bestand. */
sealed class DownloadResult {
    data class Ok(val bytes: Long) : DownloadResult()

    /** 401: de sessie is verlopen of ingetrokken. */
    object Unauthorized : DownloadResult()

    /** 404: de bijlage bestaat niet (meer) of is niet voor deze gebruiker. */
    object NotFound : DownloadResult()

    /** Groter dan wat de app wil binnenhalen. */
    object TooLarge : DownloadResult()

    data class Failed(val problem: NetProblem?, val status: Int) : DownloadResult()
}

/** Een commando voor `POST /api/v1/sync`. */
data class SyncCommand(val type: String, val uuid: String, val args: Map<String, Any?>)

/**
 * De verzoeken die de app zelf (buiten de WebView om) aan de server doet. Gewone HttpURLConnection met time-outs,
 * geen extra bibliotheek en geen Android-klassen. Gooit nooit: elke fout komt terug als uitkomst.
 *
 * @param origin de oorsprong van de server, zonder schuine streep aan het eind
 */
class ApiClient(
    private val origin: String,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 20_000,
    private val userAgent: String? = null,
) {
    private class Response(val status: Int, val body: String?, val location: String?)

    fun health(): HealthResult {
        val response = try {
            request("GET", "/health", token = null, body = null)
        } catch (e: Exception) {
            return HealthResult.Unreachable(classify(e))
        }
        if (response.status in 300..399) return HealthResult.Redirect(response.location)
        val ok = response.status == 200 && Json.parseObject(response.body)?.get("ok") == true
        return if (ok) HealthResult.Ok else HealthResult.NotTickory(response.status)
    }

    /** Haalt alle taken en de herinneringen van de ingelogde gebruiker op. */
    fun fetchSnapshot(token: String): FetchResult {
        val body = Json.stringify(mapOf("sync_token" to "*", "resource_types" to listOf("tasks", "reminders", "projects", "sections", "labels")))
        val response = try {
            request("POST", SYNC_PATH, token, body)
        } catch (e: Exception) {
            return FetchResult.Failed(classify(e), 0)
        }
        if (response.status == 401) return FetchResult.Unauthorized
        if (response.status != 200) return FetchResult.Failed(null, response.status)
        val snapshot = SyncParser.parseSnapshot(response.body) ?: return FetchResult.Failed(null, response.status)
        return FetchResult.Ok(snapshot, WidgetParser.parse(response.body))
    }

    /**
     * Stuurt commando's in één verzoek (hooguit [WidgetQueue.BATCH]). Met dezelfde uuid's opnieuw sturen is veilig: de server
     * voert elk uuid één keer uit en geeft daarna dezelfde uitkomst.
     */
    fun sendCommands(token: String, commands: List<SyncCommand>): BatchResult {
        val list = commands.map { mapOf("type" to it.type, "uuid" to it.uuid, "args" to it.args) }
        // Alleen de uitkomsten zijn nodig; "settings" houdt het antwoord klein.
        val body = Json.stringify(mapOf("sync_token" to "*", "resource_types" to listOf("settings"), "commands" to list))
        val response = try {
            request("POST", SYNC_PATH, token, body)
        } catch (e: Exception) {
            return BatchResult.Failed
        }
        return when {
            response.status == 401 -> BatchResult.Unauthorized
            response.status == 200 -> {
                if (Json.parseObject(response.body)?.obj("sync_status") == null) return BatchResult.Failed
                BatchResult.Done(commands.associate { it.uuid to SyncParser.commandStatus(response.body, it.uuid) })
            }
            response.status in 400..499 && response.status != 408 && response.status != 429 ->
                BatchResult.Rejected(Json.parseObject(response.body)?.text("error_code") ?: "HTTP_${response.status}")
            else -> BatchResult.Failed
        }
    }

    /** Vinkt een taak af. Met hetzelfde [uuid] opnieuw aanroepen is veilig: de server voert het maar één keer uit. */
    fun completeTask(token: String, taskId: String, uuid: String): CompleteResult {
        val command = mapOf("type" to "task_complete", "uuid" to uuid, "args" to mapOf("id" to taskId))
        // Alleen de uitkomst van het commando is nodig; "reminders" houdt het antwoord klein.
        val body = Json.stringify(mapOf("sync_token" to "*", "resource_types" to listOf("reminders"), "commands" to listOf(command)))
        val response = try {
            request("POST", SYNC_PATH, token, body)
        } catch (e: Exception) {
            return CompleteResult.Failed(classify(e), 0)
        }
        return when {
            response.status == 401 -> CompleteResult.Unauthorized
            response.status == 200 -> when (val status = SyncParser.commandStatus(response.body, uuid)) {
                is CommandStatus.Ok -> CompleteResult.Done
                is CommandStatus.Rejected -> CompleteResult.Rejected(status.code, status.message)
                is CommandStatus.Missing -> CompleteResult.Failed(null, 200)
            }
            // 400, 403, 404, 413: het verzoek zelf deugt niet voor deze server; opnieuw sturen verandert daar niets aan.
            // 408 (te traag) en 429 (te vaak) zijn tijdelijk, net als alles vanaf 500.
            response.status in 400..499 && response.status != 408 && response.status != 429 -> {
                val error = Json.parseObject(response.body)
                CompleteResult.Rejected(error?.text("error_code") ?: "HTTP_${response.status}", error?.text("error") ?: "")
            }
            else -> CompleteResult.Failed(null, response.status)
        }
    }

    /**
     * Haalt een bestand op (een bijlage) en schrijft het naar [target]. Het token gaat in de Authorization-header, nooit in het
     * adres. Een mislukte of afgebroken download laat geen half bestand achter.
     */
    fun downloadTo(token: String, path: String, target: File, maxBytes: Long): DownloadResult {
        val connection = try {
            URL(origin + path).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            return DownloadResult.Failed(classify(e), 0)
        }
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent)
            connection.setRequestProperty("Authorization", "Bearer $token")
            val status = connection.responseCode
            if (status == 401) return DownloadResult.Unauthorized
            if (status == 404) return DownloadResult.NotFound
            if (status != 200) return DownloadResult.Failed(null, status)
            val declared = connection.contentLengthLong
            if (declared > maxBytes) return DownloadResult.TooLarge
            var total = 0L
            target.parentFile?.mkdirs()
            try {
                connection.inputStream.use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(32 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > maxBytes) {
                                target.delete()
                                return DownloadResult.TooLarge
                            }
                            output.write(buffer, 0, n)
                        }
                    }
                }
            } catch (e: IOException) {
                target.delete()
                return DownloadResult.Failed(classify(e), 0)
            }
            if (declared >= 0 && declared != total) {
                target.delete()
                return DownloadResult.Failed(null, status)
            }
            return DownloadResult.Ok(total)
        } catch (e: IOException) {
            target.delete()
            return DownloadResult.Failed(classify(e), 0)
        } finally {
            connection.disconnect()
        }
    }

    @Throws(IOException::class)
    private fun request(method: String, path: String, token: String?, body: String?): Response {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = false // een verwijzing volgen we nooit ongezien, zeker niet met het token erbij
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent)
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream: InputStream? = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { readLimited(it) }
            return Response(status, text, connection.getHeaderField("Location"))
        } finally {
            connection.disconnect()
        }
    }

    /** Leest het antwoord, maar niet onbeperkt: een antwoord boven de grens is geen antwoord van onze server. */
    private fun readLimited(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (out.size() + n > MAX_RESPONSE_BYTES) return null
            out.write(buffer, 0, n)
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    companion object {
        const val SYNC_PATH = "/api/v1/sync"
        const val MAX_RESPONSE_BYTES = 32 * 1024 * 1024

        fun classify(e: Throwable): NetProblem = when (e) {
            is UnknownHostException -> NetProblem.UNKNOWN_HOST
            is SocketTimeoutException -> NetProblem.TIMEOUT
            is SSLException -> NetProblem.TLS
            is ConnectException, is NoRouteToHostException, is SocketException -> NetProblem.CONNECT
            else -> NetProblem.OTHER
        }
    }
}
