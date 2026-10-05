/**
 * Copy each app's EXPO_PUBLIC_ values into EAS's "production" environment,
 * so a release build carries them.
 *
 *   pnpm release:env            check, then set them on EAS
 *   pnpm release:env --check    check only; change nothing
 *
 * Why this exists: a cloud EAS build gets the repository's files, and the
 * apps' .env files are gitignored, so a release APK built in the cloud would
 * ship with no relay, no settlement service and the public RPC. Expo inlines
 * EXPO_PUBLIC_ values when the bundle is built, so they have to be on EAS
 * before `eas build`. (A development build reads them from Metro instead,
 * which is why that never came up.)
 *
 * What a release build can use, which a development build is more forgiving
 * about, is checked first:
 *   - the relay (both apps) and the settlement service (merchant) must be
 *     https: Android refuses plain http outside development builds, so a
 *     LAN address that works with Metro fails silently in a release APK;
 *   - the address must be a stable one, not a quick tunnel's, which changes
 *     on every restart while the APK keeps the old one forever.
 *
 * Every EXPO_PUBLIC_ value ends up inside the APK and is public by
 * definition. They are still set as "sensitive" where they carry a key (the
 * RPC URL) or a token, so the EAS dashboard does not display them. No value
 * is printed here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

function readEnv(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?(EXPO_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2]!.replace(/^["']|["']$/g, "").trim();
    if (value) out.set(m[1]!, value);
  }
  return out;
}

const httpsStable = (v: string) =>
  /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?(\/\S*)?$/.test(v) && !/trycloudflare\.com/.test(v);

const apps = [
  { name: "merchant", needs: ["EXPO_PUBLIC_NELO_RELAY_URL", "EXPO_PUBLIC_NELO_RELAY_TOKEN"], https: ["EXPO_PUBLIC_NELO_RELAY_URL", "EXPO_PUBLIC_NELO_SETTLE_URL"] },
  { name: "payer", needs: ["EXPO_PUBLIC_NELO_RELAY_URL", "EXPO_PUBLIC_NELO_RELAY_TOKEN"], https: ["EXPO_PUBLIC_NELO_RELAY_URL"] },
];

const problems: string[] = [];
const plan: { app: string; name: string; value: string }[] = [];

for (const app of apps) {
  const file = join(root, "apps", app.name, ".env");
  const env = readEnv(file);
  if (env.size === 0) {
    problems.push(`apps/${app.name}/.env has no EXPO_PUBLIC_ values. Run pnpm setup:env first.`);
    continue;
  }
  for (const k of app.needs) if (!env.get(k)) problems.push(`apps/${app.name}/.env: ${k} is empty; a release build needs it.`);
  for (const k of app.https) {
    const v = env.get(k);
    if (v && !httpsStable(v)) {
      problems.push(
        `apps/${app.name}/.env: ${k} must be a stable https address for a release build (got ${v.startsWith("http://") ? "a plain-http address" : /trycloudflare/.test(v) ? "a quick tunnel, which changes on restart" : "something else"}). See docs-site/operations/release.mdx.`,
      );
    }
  }
  for (const [name, value] of env) plan.push({ app: app.name, name, value });
}

if (problems.length) {
  console.error("Not ready for a release build:\n  " + problems.join("\n  "));
  process.exit(1);
}

for (const app of apps) {
  const names = plan.filter((p) => p.app === app.name).map((p) => p.name);
  console.log(`${app.name}: ${names.join(", ")}`);
}
if (checkOnly) {
  console.log("\nReady. Run `pnpm release:env` to set these on EAS.");
  process.exit(0);
}

const sensitive = (name: string) => /TOKEN|RPC_URL|RPC_FALLBACK/.test(name);
let failed = 0;
for (const p of plan) {
  const r = spawnSync(
    "npx",
    [
      "eas", "env:set",
      "--environment", "production",
      "--name", p.name,
      "--value", p.value,
      "--visibility", sensitive(p.name) ? "sensitive" : "plaintext",
      "--non-interactive",
    ],
    { cwd: join(root, "apps", p.app), stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (r.status === 0) console.log(`  set ${p.app} ${p.name}`);
  else {
    failed++;
    // eas prints the value back in some errors; show only its first line, with the value removed.
    const first = (r.stderr || "").split("\n").find((l) => l.trim()) ?? "unknown error";
    console.error(`  FAILED ${p.app} ${p.name}: ${first.split(p.value).join("…")}`);
  }
}
if (failed) {
  console.error(`\n${failed} not set. Check \`npx eas whoami\` (log in with \`npx eas login\`), then run this again.`);
  process.exit(1);
}
console.log("\nDone. Build: pnpm --filter @nelo/merchant build:release  and  pnpm --filter @nelo/payer build:release");
