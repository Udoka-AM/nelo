/**
 * The waitlist form. Without JS it is an ordinary form POST to the endpoint;
 * with JS it posts in the background and the card turns into a confirmation.
 *
 * The endpoint is set at build time from VITE_WAITLIST_ENDPOINT (a Formspree
 * form, or anything that accepts the same POST and answers JSON). With none
 * set, the form says the list is not open yet and sends nothing: collecting
 * addresses with nowhere to keep them would lose them.
 */
export function initWaitlist() {
  const form = document.querySelector<HTMLFormElement>("[data-waitlist]");
  if (!form) return;
  const note = form.querySelector<HTMLElement>(".form__note")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const done = form.parentElement!.querySelector<HTMLElement>(".done")!;
  const endpoint = form.getAttribute("action") ?? "";

  if (!/^https:\/\//.test(endpoint)) {
    form.dataset.closed = "";
    form.querySelectorAll("input, button").forEach((el) => ((el as HTMLInputElement).disabled = true));
    button.querySelector("span")!.textContent = "Opening soon";
    note.textContent = "The waitlist opens in a few days.";
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    button.disabled = true;
    note.classList.remove("is-error");
    note.textContent = "Adding you…";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(String(response.status));
      form.hidden = true;
      done.hidden = false;
      done.querySelector("h3")?.setAttribute("tabindex", "-1");
      done.querySelector<HTMLElement>("h3")?.focus();
    } catch {
      note.classList.add("is-error");
      note.textContent = navigator.onLine
        ? "That didn't go through. Try again in a moment."
        : "You're offline. Try again when you have signal.";
      button.disabled = false;
    }
  });
}
