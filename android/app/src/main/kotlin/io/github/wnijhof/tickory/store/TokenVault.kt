package io.github.wnijhof.tickory.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import io.github.wnijhof.tickory.core.TokenCipher
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Bewaart het sessietoken versleuteld. De AES-sleutel zit in de Android Keystore: de app kan ermee versleutelen en
 * ontsleutelen, maar de sleutel zelf is niet uit te lezen, ook niet uit een kopie van de opslag van de app.
 * Lukt versleutelen niet, dan bewaren we niets; het token komt nooit als leesbare tekst op schijf.
 */
object TokenVault {
    private const val TAG = "TickoryVault"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "tickory-session-v1"

    /**
     * Waar de sleutel vandaan komt: op de telefoon altijd de Android Keystore. Alleen tests vervangen dit, omdat de
     * Keystore op een pc niet bestaat.
     */
    @Volatile
    internal var keySource: () -> SecretKey = ::keystoreKey

    /** @return false als het token niet (versleuteld) bewaard kon worden */
    @Synchronized
    fun save(context: Context, token: String): Boolean = try {
        Prefs(context).encryptedToken = TokenCipher.encrypt(keySource(), token)
        true
    } catch (e: Exception) {
        Log.w(TAG, "token bewaren mislukt: ${e.javaClass.simpleName}")
        false
    }

    /** Het token, of null als er geen is of als het niet meer te ontsleutelen is (bijvoorbeeld na een overzetting naar een ander toestel). */
    @Synchronized
    fun load(context: Context): String? {
        val stored = Prefs(context).encryptedToken ?: return null
        return try {
            TokenCipher.decrypt(keySource(), stored)
        } catch (e: Exception) {
            Log.w(TAG, "token lezen mislukt: ${e.javaClass.simpleName}")
            null
        }
    }

    @Synchronized
    fun clear(context: Context) {
        Prefs(context).encryptedToken = null
        try {
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS)
        } catch (e: Exception) {
            Log.w(TAG, "sleutel wissen mislukt: ${e.javaClass.simpleName}")
        }
    }

    /** De sleutel uit de Android Keystore; bestaat hij nog niet, dan wordt hij daar aangemaakt (AES-256, alleen voor GCM). */
    private fun keystoreKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
