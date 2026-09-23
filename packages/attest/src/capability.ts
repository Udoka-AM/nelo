/**
 * What a handset can be *shown* to back a key with — recorded, not inferred.
 *
 * ## Why this exists
 *
 * `docs/RESERVE.md` prices the offline path off `overspendAttemptRate`, and
 * that input says in its own source line that "StrongBox attestation is the
 * barrier". How many handsets in the launch markets actually have StrongBox is
 * therefore load-bearing on the reserve line — and nobody has measured it. It
 * is a guess sitting under a number the deck quotes.
 *
 * The app already asks the question on every device it runs on. This turns the
 * answer into a record that can be written down, so the guess can become a
 * count.
 *
 * ## The distinction this module refuses to blur
 *
 * `isStrongBoxAvailable()` checks one system feature,
 * `FEATURE_STRONGBOX_KEYSTORE`. False means **no discrete secure element**. It
 * does **not** mean "TEE-backed":
 *
 *   - a TEE-backed key lives in TrustZone on the main SoC, and
 *   - a software-backed key lives in the app's own process,
 *
 * and this check cannot tell those two apart. Proving TEE backing needs
 * `KeyInfo.isInsideSecureHardware()` or the `securityLevel` field of a real
 * attestation certificate — neither of which the native module exposes today.
 *
 * So the three states here are `strongbox`, `no-strongbox` and `unknown`. There
 * is deliberately no `tee`, because nothing in this repository can currently
 * produce one honestly. Writing `tee` into a record would be inventing the
 * measurement the record exists to collect.
 *
 * ## What is deliberately not carried
 *
 * `Platform.constants` on Android also offers `Serial` and `Fingerprint`. Both
 * identify a handset; neither answers the question. A record that answers "how
 * many Tecnos have StrongBox" needs the model and nothing more, so the shape
 * below is the whole shape, and `recordKeys` exists so that adding an
 * identifier later fails a test rather than shipping.
 */

/** What the Keystore can be *shown* to back a key with. Never inferred. */
export type KeyBacking = "strongbox" | "no-strongbox" | "unknown";

/**
 * The slice of `Platform.constants` this needs, on Android.
 *
 * Optional throughout because the caller is passing values from a platform
 * object that is typed as a union — on anything but Android these are simply
 * not there, and a record from a non-Android host should degrade to nulls
 * rather than throw.
 */
export interface AndroidBuild {
  /** `Platform.constants.Version` — the API level, 28+ for StrongBox. */
  apiLevel?: number | null;
  /** `Platform.constants.Release` — the consumer-facing version, e.g. "13". */
  release?: string | null;
  manufacturer?: string | null;
  model?: string | null;
}

export interface CapabilityInput {
  /** Whether `@nelo/attest`'s native module loaded at all. */
  moduleLoaded: boolean;
  /** `isStrongBoxAvailable()`. Only meaningful when the module loaded. */
  strongBox: boolean;
  build?: AndroidBuild | null;
  /** Epoch milliseconds. Injected so a record is reproducible in a test. */
  observedAt?: number;
}

export interface DeviceCapability {
  backing: KeyBacking;
  apiLevel: number | null;
  release: string | null;
  manufacturer: string | null;
  model: string | null;
  /** ISO-8601, to the second. */
  observedAt: string;
}

/** Every key a record may carry. Pinned by a test; see the header. */
export const recordKeys = [
  "backing",
  "apiLevel",
  "release",
  "manufacturer",
  "model",
  "observedAt",
] as const;

/**
 * Model and manufacturer strings come off the device as-is, and devices lie
 * about them in small ways — trailing spaces, empty strings for "unset". An
 * empty string in a dataset reads as a value; null reads as missing, which is
 * what it is.
 */
function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `Platform.Version` is a number on Android and a string everywhere else, so a
 * record built on the wrong platform must not carry a plausible-looking
 * integer. Anything that is not a positive whole number is missing data.
 */
function apiLevel(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * The one judgement in this file.
 *
 * A build without the native module cannot answer the question, so it reports
 * `unknown` **whatever `strongBox` says** — a `false` from a build that never
 * asked the hardware is a false negative, and a false negative in this dataset
 * would under-count StrongBox and push the reserve line the wrong way.
 */
function backingOf(moduleLoaded: boolean, strongBox: boolean): KeyBacking {
  if (!moduleLoaded) return "unknown";
  return strongBox ? "strongbox" : "no-strongbox";
}

export function capability(input: CapabilityInput): DeviceCapability {
  const build = input.build ?? {};
  const at = typeof input.observedAt === "number" ? input.observedAt : Date.now();
  return {
    backing: backingOf(input.moduleLoaded, input.strongBox),
    apiLevel: apiLevel(build.apiLevel),
    release: text(build.release),
    manufacturer: text(build.manufacturer),
    model: text(build.model),
    // Seconds, not milliseconds: this records which handset was seen, not when
    // to the millisecond, and a shorter string is one a person can read back.
    observedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/**
 * One line, for a person to write down.
 *
 * There is no backend to post this to — `services/settle` and `services/relay`
 * are libraries with no HTTP surface, and there is no enrolment flow yet. Until
 * there is, the collection channel is a human reading a screen, so the record
 * has a canonical string form: tab-separated, fixed field order, missing values
 * as "?", so a column of them pastes into a spreadsheet and lines up.
 */
export function capabilityLine(record: DeviceCapability): string {
  const or = (v: string | number | null) => (v === null ? "?" : String(v));
  return [
    record.backing,
    or(record.manufacturer),
    or(record.model),
    `api${or(record.apiLevel)}`,
    record.observedAt,
  ].join("\t");
}
