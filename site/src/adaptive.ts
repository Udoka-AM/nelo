/**
 * What this visitor's network and device can take, decided once before first
 * paint (the inline script in index.html) and revised here as it changes.
 *
 *   lite      save-data, reduced-data, 2G, or a phone with ~1 GB of memory.
 *             Posters instead of video, no smooth scroll, no blur, CSS motion.
 *   standard  3G, a modest phone, or no Network Information API to ask.
 *             Video from the lowest rendition up, GSAP motion.
 *   rich      4G or better on a capable device. Everything.
 *
 * The Network Information API exists in Chromium only. Safari and Firefox
 * report nothing, so they start at "standard" and let the video player's own
 * bandwidth estimate (hls.js, or Safari's native HLS) do the adapting.
 */
export type Tier = "lite" | "standard" | "rich";

interface NetworkInformation extends EventTarget {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
}

const nav = navigator as Navigator & { connection?: NetworkInformation; deviceMemory?: number };
const media = (q: string) => window.matchMedia?.(q).matches ?? false;

export function measure(): Tier {
  const c = nav.connection;
  const memory = nav.deviceMemory;
  const cores = navigator.hardwareConcurrency || 8;
  if (c?.saveData || media("(prefers-reduced-data: reduce)")) return "lite";
  if (c?.effectiveType === "slow-2g" || c?.effectiveType === "2g") return "lite";
  if (memory !== undefined && memory <= 1) return "lite";
  // A high round-trip time on a "4g" label is common on congested networks.
  const slow = c?.effectiveType === "3g" || (c?.rtt !== undefined && c.rtt > 400) || (c?.downlink !== undefined && c.downlink < 1.5);
  const modest = (memory !== undefined && memory < 4) || cores < 4;
  if (slow || modest) return "standard";
  return c?.effectiveType === "4g" || !c ? "rich" : "standard";
}

export const tier = (): Tier => document.documentElement.dataset.tier as Tier;
export const reducedMotion = () => document.documentElement.dataset.motion === "reduced";
export const finePointer = () => media("(hover: hover) and (pointer: fine)");

const listeners = new Set<(t: Tier) => void>();
export function onTierChange(fn: (t: Tier) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(t: Tier) {
  if (t === tier()) return;
  document.documentElement.dataset.tier = t;
  listeners.forEach((fn) => fn(t));
}

/** Follow the connection as it changes: a train into a tunnel, a switch to Wi-Fi. */
export function watch() {
  set(measure());
  nav.connection?.addEventListener("change", () => set(measure()));
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => {
    document.documentElement.dataset.motion = e.matches ? "reduced" : "full";
  });
}

/**
 * The player's own measurement, once video has played: if what actually
 * arrives is far below what the label promised, step down for everything else
 * on the page too. Never steps up from here; the connection API does that.
 */
export function reportThroughput(bitsPerSecond: number) {
  if (bitsPerSecond > 0 && bitsPerSecond < 250_000 && tier() !== "lite") set("lite");
  else if (bitsPerSecond > 0 && bitsPerSecond < 1_200_000 && tier() === "rich") set("standard");
}
