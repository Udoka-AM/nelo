/**
 * nelo reserve — the insurance line, modelled.
 *
 * The week-2 gate asks for this: *"Model the reserve requirement this week —
 * the SKR premium is priced off it, and the deck asserts that. An unmodelled
 * multiplier is a number this panel will ask about."*
 *
 * Read `docs/RESERVE.md` for what it concludes, or run the report:
 *
 *   pnpm --filter @nelo/reserve report
 *
 * **Nothing here is a measurement.** Every input is graded, and the ones nobody
 * has a real figure for are listed by `unsourcedInputs()` and printed at the top
 * of the report. The model's value is that it says what would have to be true,
 * not that it says what is true.
 */
export * from "./assumptions.ts";
export * from "./curve.ts";
export * from "./model.ts";
