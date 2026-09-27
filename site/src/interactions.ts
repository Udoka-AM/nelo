/**
 * Things that answer the pointer: buttons that light up where you touch them
 * and ripple from the exact point, cards that tilt toward the cursor with a
 * glare, a hero stage that leans with you, a glow that follows the mouse, and
 * a nav pill that slides between links.
 *
 * No library: each is a few CSS custom properties set in a requestAnimationFrame.
 * Ripples and button light run everywhere; the rest only with a fine pointer,
 * full motion, and a tier above lite.
 */
import { finePointer, reducedMotion, tier } from "./adaptive";

/** Set custom properties at most once a frame per element. */
function rafProps(el: HTMLElement) {
  let frame = 0;
  let pending: Record<string, string> = {};
  return (props: Record<string, string>) => {
    Object.assign(pending, props);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      for (const [k, v] of Object.entries(pending)) el.style.setProperty(k, v);
      pending = {};
      frame = 0;
    });
  };
}

function buttons() {
  for (const btn of document.querySelectorAll<HTMLElement>(".btn, .theme")) {
    const set = rafProps(btn);
    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      set({ "--bx": `${e.clientX - r.left}px`, "--by": `${e.clientY - r.top}px` });
    });
    // A ripple from exactly where the finger or cursor went down.
    btn.addEventListener("pointerdown", (e) => {
      if (reducedMotion()) return;
      const r = btn.getBoundingClientRect();
      const ring = document.createElement("span");
      ring.className = "ripple";
      const size = Math.hypot(r.width, r.height) * 2;
      ring.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
      btn.appendChild(ring);
      ring.addEventListener("animationend", () => ring.remove(), { once: true });
    });
  }
}

/** Cards lean toward the pointer, with a glare where the light would catch. */
function tilt() {
  const MAX = 7; // degrees
  for (const card of document.querySelectorAll<HTMLElement>(".till-card, .step-card, .tile")) {
    card.classList.add("tilts");
    const set = rafProps(card);
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      set({
        "--ry": `${((x - 0.5) * 2 * MAX).toFixed(2)}deg`,
        "--rx": `${((0.5 - y) * 2 * MAX).toFixed(2)}deg`,
        "--gx": `${(x * 100).toFixed(1)}%`,
        "--gy": `${(y * 100).toFixed(1)}%`,
      });
      card.classList.add("is-tilting");
    });
    card.addEventListener("pointerleave", () => {
      card.classList.remove("is-tilting");
      set({ "--rx": "0deg", "--ry": "0deg" });
    });
  }
}

/** The hero stage leans with the pointer, and a soft glow follows it. */
function heroParallax() {
  const hero = document.querySelector<HTMLElement>(".hero");
  const stage = hero?.querySelector<HTMLElement>(".hero__stage");
  if (!hero || !stage) return;
  const glow = document.createElement("div");
  glow.className = "cursor-glow";
  glow.setAttribute("aria-hidden", "true");
  hero.appendChild(glow);

  // Eased toward the pointer, so it drifts rather than snaps.
  let tx = 0.5, ty = 0.5, cx = 0.5, cy = 0.5, gx = 0, gy = 0, cgx = 0, cgy = 0;
  let running = false;
  const step = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    cgx += (gx - cgx) * 0.12;
    cgy += (gy - cgy) * 0.12;
    stage.style.setProperty("--sry", `${((cx - 0.5) * 10).toFixed(2)}deg`);
    stage.style.setProperty("--srx", `${((0.5 - cy) * 6).toFixed(2)}deg`);
    glow.style.translate = `${cgx.toFixed(1)}px ${cgy.toFixed(1)}px`;
    if (Math.abs(tx - cx) + Math.abs(ty - cy) + Math.abs(gx - cgx) + Math.abs(gy - cgy) > 0.002) {
      requestAnimationFrame(step);
    } else running = false;
  };
  const kick = () => {
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
  };
  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    tx = (e.clientX - r.left) / r.width;
    ty = (e.clientY - r.top) / r.height;
    gx = e.clientX - r.left;
    gy = e.clientY - r.top;
    glow.classList.add("is-on");
    kick();
  });
  hero.addEventListener("pointerleave", () => {
    tx = ty = 0.5;
    glow.classList.remove("is-on");
    kick();
  });
}

/** A pill that slides to whichever nav link is under the pointer. */
function navPill() {
  const links = document.querySelector<HTMLElement>(".nav__links");
  if (!links) return;
  const pill = document.createElement("span");
  pill.className = "nav__pill";
  pill.setAttribute("aria-hidden", "true");
  links.prepend(pill);
  for (const a of links.querySelectorAll<HTMLElement>("a")) {
    const move = () => {
      pill.style.width = `${a.offsetWidth}px`;
      pill.style.translate = `${a.offsetLeft}px 0`;
      pill.classList.add("is-on");
    };
    a.addEventListener("pointerenter", move);
    a.addEventListener("focus", move);
  }
  links.addEventListener("pointerleave", () => pill.classList.remove("is-on"));
}

/** A hairline across the top that fills as the page is read. CSS does it where it can. */
function scrollProgress() {
  const bar = document.createElement("div");
  bar.className = "progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.appendChild(bar);
  if (CSS.supports("animation-timeline: scroll()")) return;
  let frame = 0;
  addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      });
    },
    { passive: true },
  );
}

export function initInteractions() {
  buttons();
  scrollProgress();
  if (reducedMotion() || tier() === "lite" || !finePointer()) return;
  tilt();
  heroParallax();
  navPill();
}
