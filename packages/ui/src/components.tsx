/**
 * The components every Nelo screen is built from.
 *
 * Few, on purpose: a screen that needs something these do not do should
 * question the need before adding a style. Each one carries its own
 * accessibility role and a touch target of at least 48dp, so a screen gets
 * both by using it rather than by remembering to.
 */
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { color, radius, space, touch, type, weight } from "./tokens.ts";

// ---- screens ----

export function Screen({ children, scroll = true, center = false }: { children: ReactNode; scroll?: boolean; center?: boolean }) {
  const body = [styles.body, center && styles.center];
  return (
    <View style={styles.screen}>
      {scroll ? (
        <ScrollView contentContainerStyle={body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, ...body]}>{children}</View>
      )}
    </View>
  );
}

export interface Action {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}

/** A screen's title, with its way out and at most one other action on the right. */
export function Header({ title, actions = [] }: { title: string; actions?: Action[] }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.headerActions}>
        {actions.map((a) => (
          <TextButton key={a.label} {...a} />
        ))}
      </View>
    </View>
  );
}

// ---- actions ----

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled = false,
  busy = false,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        styles.button,
        kind === "primary" ? styles.primary : styles.secondary,
        pressed && !off && (kind === "primary" ? styles.primaryPressed : styles.secondaryPressed),
        disabled && styles.disabled,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={kind === "primary" ? color.onPrimary : color.text} style={styles.busy} /> : null}
      <Text style={[styles.buttonText, kind === "secondary" && styles.secondaryText, disabled && styles.disabledText]}>{label}</Text>
    </Pressable>
  );
}

/** A quiet action: "Done", "Change", "Close the day". Still 48dp to press. */
export function TextButton({ label, onPress, accessibilityLabel, tone = "muted", disabled = false }: Action & { tone?: "muted" | "positive"; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={({ pressed }) => [styles.textButton, pressed && { opacity: 0.6 }]}
    >
      <Text style={[styles.textButtonText, tone === "positive" && { color: color.positive }, disabled && { color: color.disabledText }]}>{label}</Text>
    </Pressable>
  );
}

// ---- text ----

type TextProps = { children: ReactNode; style?: StyleProp<TextStyle>; center?: boolean; tone?: Tone; selectable?: boolean };
export type Tone = "default" | "muted" | "positive" | "caution" | "danger";
const toneColor: Record<Tone, string> = {
  default: color.text,
  muted: color.textMuted,
  positive: color.positive,
  caution: color.caution,
  danger: color.danger,
};
const make = (base: TextStyle, defaultTone: Tone = "default") =>
  function T({ children, style, center, tone, selectable }: TextProps) {
    return (
      <Text selectable={selectable} style={[base, { color: toneColor[tone ?? defaultTone] }, center && { textAlign: "center" }, style]}>
        {children}
      </Text>
    );
  };

/** Tabular figures, so amounts in a column line up and do not jitter as they change. */
const figures: TextStyle = { fontVariant: ["tabular-nums"] };

export const Display = make({ fontSize: type.display, fontWeight: weight.bold, letterSpacing: -1.5, ...figures });
export const Hero = make({ fontSize: type.hero, fontWeight: weight.bold, letterSpacing: -0.8, ...figures });
export const Title = make({ fontSize: type.title, fontWeight: weight.bold, letterSpacing: -0.5 });
export const Heading = make({ fontSize: type.heading, fontWeight: weight.medium });
export const Body = make({ fontSize: type.body, lineHeight: 24 });
export const Muted = make({ fontSize: type.body, lineHeight: 24 }, "muted");
export const Small = make({ fontSize: type.small, lineHeight: 20 }, "muted");
export const Label = make({ fontSize: type.caption, fontWeight: weight.medium, letterSpacing: 1.2, textTransform: "uppercase" }, "muted");
export const Figure = make({ fontSize: type.body, fontWeight: weight.medium, ...figures });

// ---- containers ----

export function Card({ children, onPress, accessibilityLabel, selected = false, style }: { children: ReactNode; onPress?: () => void; accessibilityLabel?: string; selected?: boolean; style?: StyleProp<ViewStyle> }) {
  const card = [styles.card, selected && styles.cardSelected, style];
  if (!onPress) return <View style={card}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => [...card, pressed && { backgroundColor: color.surfaceHigh }]}
    >
      {children}
    </Pressable>
  );
}

/** Something the merchant should know. The tone says how much it matters. */
export function Notice({ tone = "caution", children, action }: { tone?: "caution" | "danger" | "positive"; children: ReactNode; action?: Action }) {
  const surface = { caution: color.cautionSurface, danger: color.dangerSurface, positive: color.positiveSurface }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: surface }]} accessibilityRole="alert">
      <Text style={[styles.noticeText, { color: toneColor[tone] }]}>{children}</Text>
      {action ? <TextButton {...action} tone="positive" /> : null}
    </View>
  );
}

/** A labelled figure: "Received  ₦26,275". */
export function Row({ label, sub, value, tone = "default", strong = false }: { label: string; sub?: string; value: string; tone?: Tone; strong?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}, ${value}${sub ? `, ${sub}` : ""}`}>
      <View style={{ flexShrink: 1 }}>
        <Text style={[styles.rowLabel, strong && { fontSize: type.heading }]}>{label}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <Text style={[styles.rowValue, strong && { fontSize: type.heading + 3 }, { color: toneColor[tone] }]}>{value}</Text>
    </View>
  );
}

export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        placeholderTextColor={color.textMuted}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, input.style]}
      />
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <View style={styles.spinner} accessibilityLiveRegion="polite">
      <ActivityIndicator color={color.positive} />
      {label ? <Muted center>{label}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  body: { flexGrow: 1, paddingTop: 56, paddingHorizontal: space.xl, paddingBottom: space.xxxl, gap: space.lg },
  center: { justifyContent: "center" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: touch, marginBottom: space.xs },
  headerActions: { flexDirection: "row", gap: space.xs },
  title: { color: color.text, fontSize: type.title, fontWeight: weight.bold, letterSpacing: -0.5, flexShrink: 1 },
  button: {
    minHeight: 56,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: space.sm,
    alignSelf: "stretch",
  },
  primary: { backgroundColor: color.primary },
  primaryPressed: { backgroundColor: color.primaryPressed },
  secondary: { borderWidth: 1, borderColor: color.borderStrong },
  secondaryPressed: { backgroundColor: color.surfaceHigh },
  disabled: { backgroundColor: color.disabledSurface, borderColor: color.disabledSurface },
  buttonText: { color: color.onPrimary, fontSize: type.body + 1, fontWeight: weight.bold, textAlign: "center", flexShrink: 1 },
  secondaryText: { color: color.text, fontWeight: weight.medium },
  disabledText: { color: color.disabledText },
  busy: { marginRight: space.xs },
  textButton: { minHeight: touch, minWidth: touch, paddingHorizontal: space.sm, justifyContent: "center", alignItems: "center" },
  textButtonText: { color: color.textMuted, fontSize: type.body, fontWeight: weight.medium },
  card: { backgroundColor: color.surface, borderRadius: radius.md, padding: space.lg, gap: space.xs, borderWidth: 1, borderColor: color.surface },
  cardSelected: { borderColor: color.positive, backgroundColor: color.positiveSurface },
  notice: {
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    minHeight: touch + space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  noticeText: { flex: 1, fontSize: type.body, lineHeight: 23, fontWeight: weight.medium, paddingVertical: space.xs },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.md, paddingVertical: space.md },
  rowLabel: { color: color.text, fontSize: type.body, fontWeight: weight.medium },
  rowSub: { color: color.textMuted, fontSize: type.small, marginTop: 2 },
  rowValue: { fontSize: type.body + 1, fontWeight: weight.bold, fontVariant: ["tabular-nums"] },
  field: { gap: space.sm },
  input: {
    minHeight: 52,
    color: color.text,
    fontSize: type.heading,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    backgroundColor: color.surface,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.border },
  spinner: { gap: space.md, alignItems: "center", paddingVertical: space.xl },
});
