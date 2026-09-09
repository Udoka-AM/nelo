# @nelo/attest

Expo native module wrapping Android StrongBox.

    isStrongBoxAvailable(): boolean
    generateAttestedKey(challenge: Uint8Array): { publicKey: Uint8Array; certChain: string[] }
    sign(message: Uint8Array): Uint8Array   // P-256, normalised to raw r||s

Kotlin lives in `android/`. Key generation uses:

    KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(DIGEST_SHA256)
      .setIsStrongBoxBacked(true)
      .setAttestationChallenge(challenge)
      .build()

Android returns DER-encoded signatures. The Solana secp256r1 precompile wants raw
r||s (64 bytes). Convert on the Kotlin side and normalise low-S. Budget half a day.
