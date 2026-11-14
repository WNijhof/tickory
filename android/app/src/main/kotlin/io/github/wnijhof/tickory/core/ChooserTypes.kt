package io.github.wnijhof.tickory.core

/**
 * De bestandstypen voor de kiezer van Android, uit het `accept` van een `<input type="file">` in de web-app. Nodig voor het
 * importeren (zip, CSV of JSON): `FileChooserParams.createIntent()` van de WebView neemt alleen het eerste item uit `accept`, en een
 * uitgang als ".zip" is geen bestandstype, zodat de kiezer dan niets of het verkeerde zou tonen. Hier worden de uitgangen omgezet in
 * de typen waaronder bestandsbeheerders zulke bestanden aanbieden (ook `application/octet-stream`, dat veel apps voor een zip of CSV
 * gebruiken). Vraagt de pagina om afbeeldingen of om alles (bijlagen, foto's), dan blijft het zoals het was: null.
 */
object ChooserTypes {
    private val BY_EXTENSION = mapOf(
        ".zip" to listOf("application/zip", "application/x-zip-compressed", "application/x-zip"),
        ".csv" to listOf("text/csv", "text/comma-separated-values", "application/csv", "text/plain", "application/vnd.ms-excel"),
        ".json" to listOf("application/json", "text/plain"),
    )
    private val MIME = Regex("^[a-z0-9][a-z0-9.+-]{0,126}/[a-z0-9*][a-z0-9.+*-]{0,126}$")

    /** De typen voor `EXTRA_MIME_TYPES`, of null om de keuze van de WebView te houden (alles, of afbeeldingen met de camera). */
    fun mimeTypes(accept: Array<String>?): Array<String>? {
        val items = (accept ?: emptyArray()).flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (items.isEmpty() || items.any { it == "*/*" || it.startsWith("image/") }) return null
        val out = LinkedHashSet<String>()
        for (item in items) {
            when {
                item.startsWith(".") -> out.addAll(BY_EXTENSION[item] ?: return null) // een onbekende uitgang: dan maar alles
                MIME.matches(item) -> out.add(item)
                else -> return null
            }
        }
        out.add(AttachmentName.OCTET_STREAM)
        return out.toTypedArray()
    }
}
