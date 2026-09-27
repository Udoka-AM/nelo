/**
 * The waitlist form, writing straight to the `waitlist` table in Supabase.
 *
 * The site holds only the project's publishable key. The table lets that key
 * insert a row and nothing else: it cannot read the list back, change it, or
 * delete from it, and the database checks the email and role itself. See
 * `supabase/waitlist.sql`.
 *
 * Offline is handled the way the product handles it: a sign-up made with no
 * signal is kept on this device and sent when the connection comes back.
 */
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const PENDING = "nelo-waitlist-pending";

interface SignUp {
  email: string;
  role: "merchant" | "payer";
  page: "business" | "pay";
}

type Sent = "added" | "already" | "invalid" | "offline" | "failed";

async function send(s: SignUp): Promise<Sent> {
  if (!navigator.onLine) return "offline";
  try {
    const response = await fetch(`${URL_}/rest/v1/waitlist`, {
      method: "POST",
      headers: { apikey: KEY!, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(s),
    });
    if (response.ok) return "added";
    // A unique violation: this email is already on the list, which is success.
    if (response.status === 409) return "already";
    // A check constraint: the database did not accept the email or role.
    if (response.status === 400) return "invalid";
    return "failed";
  } catch {
    return navigator.onLine ? "failed" : "offline";
  }
}

function keep(s: SignUp) {
  try {
    localStorage.setItem(PENDING, JSON.stringify(s));
  } catch {
    /* Private mode: nothing to keep it in. */
  }
}

function pending(): SignUp | null {
  try {
    const raw = localStorage.getItem(PENDING);
    return raw ? (JSON.parse(raw) as SignUp) : null;
  } catch {
    return null;
  }
}

function forget() {
  try {
    localStorage.removeItem(PENDING);
  } catch {
    /* ignore */
  }
}

export function initWaitlist() {
  const form = document.querySelector<HTMLFormElement>("[data-waitlist]");
  if (!form) return;
  const note = form.querySelector<HTMLElement>(".form__note")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const label = button.querySelector("span")!;
  const done = form.parentElement!.querySelector<HTMLElement>(".done")!;
  const page = (form.dataset.page === "pay" ? "pay" : "business") as SignUp["page"];

  if (!URL_ || !KEY) {
    form.dataset.closed = "";
    form.querySelectorAll("input, button").forEach((el) => ((el as HTMLInputElement).disabled = true));
    label.textContent = "Opening soon";
    note.textContent = "The waitlist opens in a few days.";
    return;
  }

  const finish = (heading: string) => {
    form.hidden = true;
    done.hidden = false;
    const h = done.querySelector<HTMLElement>("h3")!;
    h.textContent = heading;
    h.setAttribute("tabindex", "-1");
    h.focus();
  };

  const say = (text: string, error = false) => {
    note.textContent = text;
    note.classList.toggle("is-error", error);
  };

  // A sign-up saved offline on an earlier visit, or earlier in this one.
  const retry = async () => {
    const saved = pending();
    if (!saved) return;
    const r = await send(saved);
    if (r === "added" || r === "already" || r === "invalid") forget();
    if (r === "added" || r === "already") finish("You're on the list.");
  };
  addEventListener("online", () => void retry());
  if (pending()) void retry();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    // The honeypot: a person never sees this field, so anything in it is a bot.
    if (String(data.get("_gotcha") ?? "")) return finish("You're on the list.");
    const signUp: SignUp = {
      email: String(data.get("email") ?? "").trim().toLowerCase(),
      role: data.get("role") === "payer" ? "payer" : "merchant",
      page,
    };

    button.disabled = true;
    label.textContent = "Adding you…";
    say("");
    const r = await send(signUp);
    button.disabled = false;
    label.textContent = "Join the waitlist";

    switch (r) {
      case "added":
        forget();
        return finish("You're on the list.");
      case "already":
        forget();
        return finish("You're already on the list.");
      case "invalid":
        return say("That email doesn't look right. Check it and try again.", true);
      case "offline":
        keep(signUp);
        return say("No signal. We've kept your sign-up and will send it when you're back online.");
      case "failed":
        return say("That didn't go through. Try again in a moment.", true);
    }
  });
}
