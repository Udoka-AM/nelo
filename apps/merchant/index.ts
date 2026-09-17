/**
 * Entry point. The polyfills come first, on purpose.
 *
 * Privy's core SDK reaches for `TextEncoder` and `crypto.getRandomValues`, and
 * Hermes provides neither. Both have to exist before any module that uses them
 * is evaluated, so they are imported here, above everything — including above
 * `./App`, which pulls in the SDK transitively.
 *
 * `@ethersproject/shims` is in Privy's documented install list and is
 * deliberately **not** here: nothing in `@privy-io/expo` or
 * `@privy-io/js-sdk-core` references it, and this app touches no Ethereum. That
 * was checked against the published packages rather than assumed.
 */
import "fast-text-encoding";
import "react-native-get-random-values";

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
