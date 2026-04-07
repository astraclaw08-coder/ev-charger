/**
 * Nunito Sans font family constants.
 *
 * React Native requires a separate fontFamily string for each weight
 * because the `fontWeight` style property is ignored when a custom
 * fontFamily is set.  The keys loaded via `expo-font` must match the
 * family names referenced here.
 */

export const Fonts = {
  light: 'NunitoSans-Light',        // 300
  regular: 'NunitoSans-Regular',     // 400
  medium: 'NunitoSans-Medium',       // 500
  semiBold: 'NunitoSans-SemiBold',   // 600
  bold: 'NunitoSans-Bold',           // 700
  extraBold: 'NunitoSans-ExtraBold', // 800
  black: 'NunitoSans-Black',         // 900
} as const;

/**
 * Map a numeric fontWeight to the correct Nunito Sans fontFamily.
 */
export function fontForWeight(weight?: string | number): string {
  switch (String(weight)) {
    case '300':
      return Fonts.light;
    case '500':
      return Fonts.medium;
    case '600':
      return Fonts.semiBold;
    case '700':
    case 'bold':
      return Fonts.bold;
    case '800':
      return Fonts.extraBold;
    case '900':
      return Fonts.black;
    case '400':
    case 'normal':
    default:
      return Fonts.regular;
  }
}

/**
 * Shorthand: returns { fontFamily } for a given weight.
 * Useful for inline styles: `style={[styles.text, f(700)]}`.
 */
export function f(weight: string | number) {
  return { fontFamily: fontForWeight(weight) };
}
