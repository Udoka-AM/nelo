/**
 * Entry point. The polyfills come first: kit and the secure-element module
 * reach for `TextEncoder` and `crypto.getRandomValues`, which Hermes lacks.
 */
import "fast-text-encoding";
import "react-native-get-random-values";

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
