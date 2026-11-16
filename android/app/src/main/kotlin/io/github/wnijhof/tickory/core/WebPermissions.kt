package io.github.wnijhof.tickory.core

/**
 * Wat de web-app via de WebView mag vragen (WebChromeClient.onPermissionRequest). Alleen de microfoon, voor geluid opnemen bij
 * een notitie, en alleen voor de pagina van de eigen server. De camera, schermopname of iets anders, en elke andere pagina:
 * geweigerd. Zonder Android-classes, zodat het in een gewone test te controleren is.
 */
object WebPermissions {
    /** Gelijk aan android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE. */
    const val AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE"

    /** Mag deze vraag (alleen [AUDIO_CAPTURE], van [requestOrigin]) door naar de gebruiker? */
    fun allowMicrophone(resources: Array<String>?, requestOrigin: String?, appOrigin: String): Boolean {
        if (resources == null || resources.isEmpty() || resources.any { it != AUDIO_CAPTURE }) return false
        return ServerAddress.sameOrigin(requestOrigin, appOrigin)
    }
}
