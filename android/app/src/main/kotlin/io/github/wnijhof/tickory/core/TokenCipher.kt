package io.github.wnijhof.tickory.core

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Versleutelt een korte tekst (het sessietoken) met AES-GCM. De sleutel komt op de telefoon uit de Android Keystore
 * en verlaat die nooit; deze code krijgt alleen een verwijzing ernaar. Het token zelf is voor ons ondoorzichtige tekst.
 *
 * Opslagvorm: "v1:" + base64( lengte van de IV (1 byte) | IV | versleutelde tekst met controlecode ).
 */
object TokenCipher {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val PREFIX = "v1:"
    private const val TAG_BITS = 128

    fun encrypt(key: SecretKey, plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key) // de IV kiest de cipher zelf; de Keystore staat geen eigen IV toe
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val packed = ByteArray(1 + iv.size + encrypted.size)
        packed[0] = iv.size.toByte()
        System.arraycopy(iv, 0, packed, 1, iv.size)
        System.arraycopy(encrypted, 0, packed, 1 + iv.size, encrypted.size)
        return PREFIX + Base64.getEncoder().encodeToString(packed)
    }

    /** De oorspronkelijke tekst, of null als [stored] beschadigd is, met een andere sleutel is gemaakt of geen "v1:" is. */
    fun decrypt(key: SecretKey, stored: String?): String? {
        if (stored == null || !stored.startsWith(PREFIX)) return null
        return try {
            val packed = Base64.getDecoder().decode(stored.substring(PREFIX.length))
            val ivLength = packed[0].toInt() and 0xff
            if (ivLength < 12 || packed.size < 1 + ivLength + TAG_BITS / 8) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, packed, 1, ivLength))
            String(cipher.doFinal(packed, 1 + ivLength, packed.size - 1 - ivLength), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}
