/**
 * Motion, loaded only on the standard and rich tiers with full motion allowed.
 * Everything here animates something that is already on the page and already
 * readable; if this file never arrives, nothing is missing.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { finePointer, tier } from "./adaptive";

gsap.registerPlugin(ScrollTrigger, SplitText);

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];

async function smoothScroll() {
  if (tier() !== "rich" || !finePointer()) return;
  const { default: Lenis } = await import("lenis");
  const lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 0.9 });
  document.documentElement.classList.add("lenis");
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  // In-page links glide rather than jump.
  for (const a of $$<HTMLAnchorElement>('a[href^="#"]')) {
    a.addEventListener("click", (e) => {
      const target = a.getAttribute("href")!;
      if (target.length < 2) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -72, duration: 1.4 });
    });
  }
}

function hero() {
  const title = $("[data-split]")!;
  const split = SplitText.create(title, { type: "lines", mask: "lines", linesClass: "line" });
  const phones = $$(".hero__stage .phone");
  const chip = $(".chip--airplane")!;

  const intro = gsap.timeline({ defaults: { ease: "expo.out" } });
  intro
    .from(split.lines, { yPercent: 110, duration: 1.3, stagger: 0.09 })
    .from(".hero .eyebrow", { opacity: 0, y: 12, duration: 0.8 }, 0)
    .from(".hero__sub", { opacity: 0, y: 24, filter: "blur(8px)", duration: 1.1 }, 0.35)
    .from(".hero__ctas", { opacity: 0, y: 24, duration: 1.1 }, 0.5)
    .from(phones, { opacity: 0, y: 180, rotateX: 28, scale: 0.9, duration: 1.8, stagger: 0.14 }, 0.3)
    .from(chip, { opacity: 0, scale: 0.6, y: 20, duration: 0.9, ease: "back.out(1.8)" }, 1.1)
    .call(() => chip.classList.add("is-on"), [], 1.7);

  // The two phones drift together as the hero scrolls away: a handshake.
  const out = gsap.timeline({
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: 0.6 },
  });
  out
    .to(".hero__copy", { y: -90, opacity: 0.15, scale: 0.94, ease: "none" }, 0)
    .to(".phone--left", { xPercent: 14, rotate: 0, y: -40, ease: "none" }, 0)
    .to(".phone--right", { xPercent: -14, rotate: 0, y: -40, ease: "none" }, 0)
    .to(chip, { y: -60, opacity: 0, ease: "none" }, 0);

  // A slow float, on the inner body so it never fights the scroll transform.
  $$(".hero__stage .phone__body").forEach((el, i) =>
    gsap.to(el, { y: -10, duration: 3 + i * 0.4, ease: "sine.inOut", yoyo: true, repeat: -1, delay: i * 0.6 }),
  );
}

function story() {
  const section = $(".story")!;
  const stage = $(".story__stage", section)!;
  const bar = $(".story__progress", section)!;
  section.classList.add("is-pinned");
  section.dataset.step = "0";

  ScrollTrigger.create({
    trigger: stage,
    start: "top top",
    end: () => `+=${window.innerHeight * 3}`,
    pin: true,
    scrub: true,
    anticipatePin: 1,
    onUpdate(self) {
      const step = String(Math.min(3, Math.floor(self.progress * 4)));
      if (section.dataset.step !== step) section.dataset.step = step;
      bar.style.setProperty("--p", self.progress.toFixed(3));
    },
  });

  // The phones turn a little as the story plays, never quite still.
  gsap.fromTo(
    ".story__phones .phone",
    { rotateY: (i) => (i ? -14 : 14), rotateX: 6 },
    {
      rotateY: (i) => (i ? -4 : 4),
      rotateX: 0,
      ease: "none",
      scrollTrigger: { trigger: stage, start: "top top", end: () => `+=${window.innerHeight * 3}`, scrub: 1 },
    },
  );
}

function sections() {
  for (const el of $$(".reveal:not(.hero .reveal)")) {
    gsap.from(el, {
      opacity: 0,
      y: 50,
      filter: "blur(10px)",
      duration: 1.2,
      ease: "expo.out",
      scrollTrigger: { trigger: el, start: "top 88%" },
    });
  }

  for (const card of $$(".app-card")) {
    gsap.from(card, {
      opacity: 0,
      y: 90,
      clipPath: "inset(10% 6% 0% 6% round 34px)",
      duration: 1.4,
      ease: "expo.out",
      scrollTrigger: { trigger: card, start: "top 85%" },
    });
  }
  for (const phone of $$("[data-parallax]")) {
    gsap.fromTo(phone, { yPercent: 18 }, { yPercent: -4, ease: "none", scrollTrigger: { trigger: phone, start: "top bottom", end: "bottom top", scrub: true } });
  }

  ScrollTrigger.batch(".tile", {
    start: "top 90%",
    onEnter: (batch) =>
      gsap.from(batch, { opacity: 0, y: 60, scale: 0.96, duration: 1.1, ease: "expo.out", stagger: 0.08 }),
    once: true,
  });

  // Tile illustrations run only while their tile is on screen.
  for (const tile of $$(".tile")) {
    ScrollTrigger.create({ trigger: tile, start: "top bottom", end: "bottom top", toggleClass: "is-live" });
  }

  for (const n of $$("[data-count]")) {
    const target = Number(n.dataset.count);
    const fmt = new Intl.NumberFormat("en-NG");
    const state = { v: 0 };
    gsap.to(state, {
      v: target,
      duration: 2.2,
      ease: "power3.out",
      onUpdate: () => (n.textContent = `₦${fmt.format(Math.round(state.v))}`),
      scrollTrigger: { trigger: n, start: "top 85%" },
    });
  }

  // The statement lights up word by word as it is read.
  const words = SplitText.create("[data-words]", { type: "words" }).words;
  gsap.fromTo(
    words,
    { opacity: 0.14 },
    { opacity: 1, stagger: 0.12, ease: "none", scrollTrigger: { trigger: ".statement", start: "top 70%", end: "bottom 60%", scrub: true } },
  );

  gsap.from(".waitlist__card", {
    opacity: 0,
    y: 70,
    scale: 0.94,
    duration: 1.3,
    ease: "expo.out",
    scrollTrigger: { trigger: ".waitlist", start: "top 75%" },
  });
}

function nav() {
  const bar = $(".nav")!;
  ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: (self) => bar.classList.toggle("is-hidden", self.direction === 1 && self.scroll() > 480),
  });
}

function magnetic() {
  if (!finePointer()) return;
  for (const el of $$("[data-magnetic]")) {
    const x = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
    const y = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      x((e.clientX - r.left - r.width / 2) * 0.25);
      y((e.clientY - r.top - r.height / 2) * 0.35);
    });
    el.addEventListener("pointerleave", () => {
      x(0);
      y(0);
    });
  }
}

export async function initMotion() {
  document.documentElement.classList.add("gsap");
  hero();
  story();
  sections();
  nav();
  magnetic();
  await smoothScroll();
  // Fonts and posters change heights; measure again once they have settled.
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
  window.addEventListener("load", () => ScrollTrigger.refresh(), { once: true });
}
