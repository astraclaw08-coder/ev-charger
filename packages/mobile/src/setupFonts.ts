/**
 * Global Text font override — patches React Native's `Text` so that
 * every `<Text>` automatically uses Nunito Sans based on its fontWeight.
 *
 * Call `patchTextDefaults()` once after fonts are loaded (in _layout.tsx).
 *
 * How it works:
 *   - Sets `Text.defaultProps.style` to `{ fontFamily: 'NunitoSans-Regular' }`
 *   - Wraps `Text.render` so that the resolved fontWeight is mapped to the
 *     correct Nunito Sans static font file (e.g. weight 700 → NunitoSans-Bold).
 *   - TextInput gets the same treatment for consistency.
 */

import { Text, TextInput, StyleSheet, type TextStyle } from 'react-native';
import { fontForWeight, Fonts } from './fonts';

function resolveFontFamily(flatStyle: TextStyle | undefined): string {
  if (!flatStyle) return Fonts.regular;

  // If user explicitly set a non-NunitoSans fontFamily, don't override
  const family = flatStyle.fontFamily;
  if (family && !family.startsWith('NunitoSans')) return family;

  const weight = flatStyle.fontWeight;
  return fontForWeight(weight);
}

export function patchTextDefaults() {
  // --- Text ---
  const origTextRender = (Text as any).render;
  if (origTextRender && !(Text as any).__nunitoPatched) {
    (Text as any).__nunitoPatched = true;
    (Text as any).render = function (props: any, ref: any) {
      const flatStyle = StyleSheet.flatten(props.style) as TextStyle | undefined;
      const fontFamily = resolveFontFamily(flatStyle);

      const patchedProps = {
        ...props,
        style: [{ fontFamily }, props.style],
      };
      return origTextRender.call(this, patchedProps, ref);
    };
  }

  // --- TextInput ---
  const origInputRender = (TextInput as any).render;
  if (origInputRender && !(TextInput as any).__nunitoPatched) {
    (TextInput as any).__nunitoPatched = true;
    (TextInput as any).render = function (props: any, ref: any) {
      const flatStyle = StyleSheet.flatten(props.style) as TextStyle | undefined;
      const fontFamily = resolveFontFamily(flatStyle);

      const patchedProps = {
        ...props,
        style: [{ fontFamily }, props.style],
      };
      return origInputRender.call(this, patchedProps, ref);
    };
  }
}
