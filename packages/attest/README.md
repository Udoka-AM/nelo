# @nelo/attest

Expo native module wrapping Android StrongBox. The secure element signs, the
chain verifies, and there is no trusted server in the value path.

```
isAvailable(): boolean                    // native module present (dev build, Android)
isStrongBoxAvailable(): boolean           // this handset has a secure element
generateAttestedKey(alias, challenge)     // → { publicKey (33B), certChain, strongBoxBacked }
sign(alias, message): Uint8Array          // P-256, raw r||s, low-S — ready for the precompile
hasKey(alias) / deleteKey(alias)
```

## The rule this module exists to enforce

**It never falls back to a software key.** `setIsStrongBoxBacked(true)` throws
`StrongBoxUnavailableException` on a device with no secure element, and that
exception is deliberately *not* retried without the flag. A silent fallback
would keep the demo working while destroying the entire security argument, so a
handset without StrongBox degrades to online-only instead.

StrongBox is API 28+ and absent on much budget hardware — which is the hardware
this product targets. Treat `isStrongBoxAvailable() === false` as an ordinary
case, not an error.

## Where the conversions live

Two shapes have to change between the phone and the chain, and both are done in
TypeScript rather than Kotlin, in `@nelo/voucher`, so they are covered by tests
that run without a handset:

- **DER → raw r‖s, low-S.** Android returns DER with an S that may be in the
  upper half of the order. That signature verifies on the phone and is rejected
  on chain. `derToRawSignature()`.
- **Uncompressed → compressed public key.** Android returns `0x04 ‖ X ‖ Y`
  (65 bytes); the vault stores 33. `compressPublicKey()`.

The Kotlin side does one conversion it cannot delegate: `BigInteger.toByteArray()`
is signed and variable-width, so the affine coordinates are pinned to exactly 32
bytes before they leave.

## Testing it

Needs a development build and a real handset — Expo Go cannot load native
modules, and an emulator has no StrongBox. `apps/payer` is the host app; its
probe screen reports what this module finds.

```bash
adb shell pm list features | grep -i strongbox   # capability, no build needed
cd apps/payer && npx eas build -p android --profile development
```
