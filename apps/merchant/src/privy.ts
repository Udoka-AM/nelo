/**
 * The Privy wiring: an SMS code, then an embedded Solana wallet.
 *
 * This is the half of step 2 that cannot be tested here. It needs a Privy app
 * ID, a development build and a handset, so it is kept **as thin as it can
 * be** — every decision it could plausibly get wrong lives in
 * `@nelo/onboard`'s `flow.ts`, under test, and what is left is: call the SDK,
 * report back what happened.
 *
 * Read alongside `flow.ts`. This file should contain no rules.
 *
 * ## Three things about this SDK that shape the code
 *
 * **`create()` is not idempotent.** `createAdditional` exists, which means
 * asking twice is a thing that can happen, and a second wallet is not
 * undoable: the merchant ends up with an address the day-book has never seen.
 * So `wallet-ready` is raised by *observing* the hook's state rather than from
 * the resolution of `create()`, and an existing wallet short-circuits the call.
 *
 * **`create()` can resolve to `null`.** The SDK documents this for Google-Drive
 * recovery on Android. We ask for Privy-managed recovery, so it should not
 * arise, but a `null` is not treated as success either way — the observer
 * decides, not the return value.
 *
 * **Privy's `user` goes non-null asynchronously**, including a beat after an
 * ordinary successful login. That is why `already-logged-in` is a distinct
 * event the machine refuses from the wallet step onwards, rather than
 * something inferred here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEmbeddedSolanaWallet, useLoginWithSMS, usePrivy } from "@privy-io/expo";
import { initialState, reduce, type Effect, type Event, type FlowState } from "@nelo/onboard";

export interface Onboarding {
  state: FlowState;
  /** The SDK has finished initialising. Until then, nothing should be offered. */
  ready: boolean;
  dispatch: (event: Event) => void;
}

export function useOnboarding(): Onboarding {
  const { isReady, user, error: initError } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithSMS();
  const solana = useEmbeddedSolanaWallet();

  const [state, setState] = useState<FlowState>(initialState);

  /**
   * The machine's state, read synchronously. `dispatch` must compute its
   * transition outside `setState`: an updater function can be called more than
   * once for a single update, and running an effect per call would send two
   * texts for one tap.
   */
  const machine = useRef(state);
  /** Latest SDK state, so a callback made one render ago does not read a stale one. */
  const solanaRef = useRef(solana);
  solanaRef.current = solana;

  const runRef = useRef<(effect: Effect) => void>(() => {});

  const dispatch = useCallback((event: Event) => {
    const { state: next, effect } = reduce(machine.current, event, Date.now());
    machine.current = next;
    setState(next);
    if (effect) runRef.current(effect);
  }, []);

  runRef.current = (effect: Effect) => {
    void (async () => {
      try {
        switch (effect.kind) {
          case "send-code":
            await sendCode({ phone: effect.e164 });
            dispatch({ type: "code-sent" });
            return;

          case "submit-code":
            await loginWithCode({ code: effect.code });
            dispatch({ type: "logged-in" });
            return;

          case "create-wallet": {
            const wallet = solanaRef.current;

            // Already there — the common case on a reinstall, and the one
            // where calling `create` again would be actively wrong.
            if (wallet.status === "connected") {
              // `publicKey` is documented as `wallets[0].address`; taking
              // either means a connected state with an empty list still yields
              // an address rather than an undefined one.
              const address = wallet.wallets[0]?.address ?? wallet.publicKey;
              if (address) {
                dispatch({ type: "wallet-ready", address });
                return;
              }
            }
            if (wallet.status === "needs-recovery") {
              // Reported, not handled. Recovery is its own flow
              // (`useRecoverEmbeddedWallet`) and is **not implemented** — so
              // the retry offered on this screen will not clear this
              // particular state, and the message says what is needed rather
              // than pretending a tap will fix it.
              dispatch({
                type: "failed",
                error: { code: "embedded_wallet_needs_recovery" },
              });
              return;
            }
            if (!wallet.create) {
              // `create` is absent only in the disconnected state, which means
              // no authenticated user. Reaching here is our bug, not Privy's.
              dispatch({ type: "failed", error: { code: "embedded_wallet_before_logged_in" } });
              return;
            }

            // Privy-managed recovery: a merchant who must never see a key
            // cannot be handed a passphrase to keep. `createAdditional` is
            // false on purpose and stated rather than defaulted.
            await wallet.create({ recoveryMethod: "privy", createAdditional: false });
            // Deliberately no dispatch. The observer below decides, because it
            // reads the SDK's own state rather than a return value.
            return;
          }
        }
      } catch (error) {
        dispatch({ type: "failed", error });
      }
    })();
  };

  // A wallet appearing is what "the wallet was created" means. Guarded by the
  // machine, so a status that settles in two steps cannot advance twice.
  useEffect(() => {
    if (machine.current.step !== "wallet") return;
    if (solana.status !== "connected") return;
    const address = solana.wallets[0]?.address ?? solana.publicKey;
    if (address) dispatch({ type: "wallet-ready", address });
  }, [solana, dispatch]);

  // An error the SDK raised while creating, surfaced rather than left as a
  // spinner that never stops.
  useEffect(() => {
    if (machine.current.step !== "wallet" || solana.status !== "error") return;
    dispatch({ type: "failed", error: { code: "embedded_wallet_creation_error" } });
  }, [solana, dispatch]);

  // A session that survived the app being killed. The machine refuses this
  // from the wallet step onwards, which is what stops it firing on the
  // ordinary happy path a beat after `logged-in`.
  useEffect(() => {
    if (!isReady || user === null) return;
    dispatch({ type: "already-logged-in" });
  }, [isReady, user, dispatch]);

  // Initialisation failed — usually storage, occasionally the app ID. It is
  // not recoverable by anything the merchant can do, so say so once.
  useEffect(() => {
    if (initError) dispatch({ type: "failed", error: initError });
  }, [initError, dispatch]);

  return { state, ready: isReady, dispatch };
}
