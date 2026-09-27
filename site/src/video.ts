/**
 * The phone screens: short loops of the real apps, streamed adaptively.
 *
 * Every <video data-clip> starts as a poster with no source, so a page that
 * never runs this file (no JS, or the lite tier) downloads a 10 KB image per
 * phone and nothing else. From here, per clip:
 *
 *   Safari / iOS   native HLS: the OS picks the rendition and switches it.
 *   Chromium, FF   hls.js over Media Source Extensions, loaded only when the
 *                  first video is about to be seen. Starts on the lowest
 *                  rendition on "standard" and estimates on "rich".
 *   neither        the single 540p MP4.
 *
 * A video plays only while it is on screen, and is not even attached until it
 * is near. On the lite tier it is not attached at all until the visitor taps
 * play, and then it is held to the lowest rendition.
 */
import type Hls from "hls.js";
import { onTierChange, reducedMotion, reportThroughput, tier } from "./adaptive";

const base = new URL("./media/", document.baseURI).href;
const master = (clip: string) => `${base}${clip}/master.m3u8`;
const mp4 = (clip: string) => `${base}${clip}/${clip}.mp4`;

let hlsModule: Promise<typeof import("hls.js/light")> | null = null;
const players = new WeakMap<HTMLVideoElement, Hls>();
const attached = new WeakSet<HTMLVideoElement>();
const visible = new WeakSet<HTMLVideoElement>();

const nativeHls = () => document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
const mse = () => "MediaSource" in window || "ManagedMediaSource" in window;

async function attach(video: HTMLVideoElement, lowest: boolean) {
  if (attached.has(video)) return;
  attached.add(video);
  const clip = video.dataset.clip!;

  if (nativeHls()) {
    video.src = master(clip);
  } else if (mse()) {
    hlsModule ??= import("hls.js/light");
    const { default: HlsCtor } = await hlsModule;
    if (!HlsCtor.isSupported()) {
      video.src = mp4(clip);
    } else {
      const hls = new HlsCtor({
        startLevel: lowest || tier() !== "rich" ? 0 : -1,
        capLevelToPlayerSize: true,
        maxBufferLength: 8,
        backBufferLength: 10,
        abrEwmaDefaultEstimate: tier() === "rich" ? 1_500_000 : 300_000,
      });
      if (lowest) hls.autoLevelCapping = 0;
      let fragments = 0;
      hls.on(HlsCtor.Events.FRAG_LOADED, () => {
        // Small segments make an early estimate noisy; wait for a few.
        if (++fragments === 4) reportThroughput(hls.bandwidthEstimate);
      });
      hls.loadSource(master(clip));
      hls.attachMedia(video);
      players.set(video, hls);
    }
  } else {
    video.src = mp4(clip);
  }
  if (visible.has(video)) play(video);
}

function play(video: HTMLVideoElement) {
  if (reducedMotion() && !video.dataset.chosen) return;
  video.play().catch(() => {
    /* Autoplay refused (low-power mode, data saver): the poster stays. */
  });
}

function addPlayButton(video: HTMLVideoElement) {
  const screen = video.parentElement!;
  if (screen.querySelector(".play")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "play";
  b.setAttribute("data-glass", "");
  b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg> Play`;
  b.setAttribute("aria-label", `Play: ${video.getAttribute("aria-label") ?? "video"}`);
  b.addEventListener("click", () => {
    video.dataset.chosen = "1";
    b.remove();
    void attach(video, true).then(() => play(video));
  });
  screen.appendChild(b);
}

export function initVideos() {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("video[data-clip]")];
  if (!videos.length) return;

  // Near the viewport: attach (or offer to). On screen: play. Off: pause.
  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const v = e.target as HTMLVideoElement;
        if (tier() === "lite" || reducedMotion()) addPlayButton(v);
        else void attach(v, false);
        near.unobserve(v);
      }
    },
    { rootMargin: "300px 0px" },
  );
  const onScreen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const v = e.target as HTMLVideoElement;
        if (e.isIntersecting) {
          visible.add(v);
          if (attached.has(v)) play(v);
        } else {
          visible.delete(v);
          v.pause();
        }
      }
    },
    { threshold: 0.35 },
  );
  videos.forEach((v) => {
    near.observe(v);
    onScreen.observe(v);
  });

  // The network got worse mid-visit: stop what is not already playing, and
  // hold the players that are to their lowest rendition.
  onTierChange((t) => {
    for (const v of videos) {
      const hls = players.get(v);
      if (t === "lite") {
        if (hls) hls.autoLevelCapping = 0;
        if (!attached.has(v)) addPlayButton(v);
      } else if (hls && !v.dataset.chosen) {
        hls.autoLevelCapping = -1;
      }
    }
  });

  // A backgrounded tab plays nothing.
  document.addEventListener("visibilitychange", () => {
    for (const v of videos) {
      if (document.hidden) v.pause();
      else if (visible.has(v) && attached.has(v)) play(v);
    }
  });
}
