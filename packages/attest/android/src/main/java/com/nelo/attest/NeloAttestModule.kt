package com.nelo.attest

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val CURVE = "secp256r1"
private const val FIELD_BYTES = 32

/**
 * Never caught and downgraded. A device without a discrete secure element must
 * fail loudly here and fall back to online-only, because a software-backed key
 * would keep the demo working while destroying the entire security argument.
 */
internal class StrongBoxUnavailable :
  CodedException("This device has no StrongBox secure element; offline vouchers are unavailable")

internal class KeyMissing(alias: String) :
  CodedException("No key is enrolled under alias '$alias'")

internal class KeygenFailed(cause: Throwable) :
  CodedException("StrongBox key generation failed: ${cause.message}")

class NeloAttestModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NeloAttest")

    /**
     * Whether this handset has a discrete secure element. StrongBox is API 28+,
     * and is absent on a lot of budget hardware — which is exactly the hardware
     * this product targets, so the answer is genuinely load-bearing.
     */
    Function("isStrongBoxAvailable") { strongBoxAvailable() }

    /**
     * Generate a P-256 signing key inside StrongBox and return its attestation
     * chain. The challenge should be a server-issued nonce: it is embedded in
     * the attestation certificate and is what stops a replayed chain.
     */
    AsyncFunction("generateAttestedKey") { alias: String, challenge: ByteArray ->
      if (!strongBoxAvailable()) throw StrongBoxUnavailable()

      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setIsStrongBoxBacked(true)
        .setAttestationChallenge(challenge)
        .build()

      val keyPair = try {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
          .apply { initialize(spec) }
          .generateKeyPair()
      } catch (e: StrongBoxUnavailableException) {
        // Deliberately not retried without setIsStrongBoxBacked. See above.
        throw StrongBoxUnavailable()
      } catch (e: Exception) {
        throw KeygenFailed(e)
      }

      mapOf(
        "publicKey" to uncompressedPoint(keyPair.public as ECPublicKey),
        "certChain" to certChain(alias),
        "strongBoxBacked" to true
      )
    }

    /**
     * Sign the voucher's 105 signed bytes. Returns Android's DER encoding as-is;
     * conversion to the raw r‖s low-S form the chain wants happens in
     * TypeScript, where it is covered by tests that run without a handset.
     */
    AsyncFunction("signDer") { alias: String, message: ByteArray ->
      val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      val key = keyStore.getKey(alias, null) as? PrivateKey ?: throw KeyMissing(alias)
      Signature.getInstance("SHA256withECDSA").run {
        initSign(key)
        update(message)
        sign()
      }
    }

    Function("hasKey") { alias: String ->
      KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.containsAlias(alias)
    }

    AsyncFunction("deleteKey") { alias: String ->
      KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(alias)
    }
  }

  private fun strongBoxAvailable(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
    val context = appContext.reactContext ?: return false
    return context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
  }

  private fun certChain(alias: String): List<String> {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    val chain = keyStore.getCertificateChain(alias) ?: return emptyList()
    return chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
  }

  /** SEC1 uncompressed: 0x04 ‖ X ‖ Y. Compressed to 33 bytes on the JS side. */
  private fun uncompressedPoint(key: ECPublicKey): ByteArray =
    byteArrayOf(0x04) + key.w.affineX.toFixedWidth() + key.w.affineY.toFixedWidth()

  /**
   * BigInteger.toByteArray is signed and variable width: it prepends 0x00 when
   * the high bit is set, and drops leading zero bytes otherwise. Both produce a
   * public key the chain will reject, so pin it to exactly 32 bytes.
   */
  private fun BigInteger.toFixedWidth(): ByteArray {
    val raw = toByteArray()
    val out = ByteArray(FIELD_BYTES)
    if (raw.size >= FIELD_BYTES) {
      raw.copyInto(out, 0, raw.size - FIELD_BYTES, raw.size)
    } else {
      raw.copyInto(out, FIELD_BYTES - raw.size, 0, raw.size)
    }
    return out
  }
}
