import lightThemeLogo from '../assets/lumeo-logo-user-transparent.png';
import darkThemeLogo from '../assets/lumeo_logo_darktheme.png';
import { usePortalTheme } from '../theme/ThemeContext';

type BrandMarkProps = {
  className?: string;
  iconOnly?: boolean;
};

export default function BrandMark({ className = '', iconOnly }: BrandMarkProps) {
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';
  const src = isDark ? darkThemeLogo : lightThemeLogo;
  const shadow = isDark ? 'drop-shadow-[0_0_18px_rgba(255,255,255,0.45)]' : 'drop-shadow-[0_2px_8px_rgba(13,104,190,0.12)]';

  if (iconOnly) {
    // The swirl icon occupies ~32% of the logo width. Render the full logo
    // at its natural width inside a clipped container that only shows the icon.
    return (
      <div className={`overflow-hidden flex items-center justify-center ${className}`.trim()} style={{ maxWidth: 36, maxHeight: 36 }}>
        <img
          src={src}
          alt="Lumeo"
          className={`h-auto max-w-none object-contain object-left ${shadow}`}
          style={{ width: 112 }}
        />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="Lumeo"
      className={`h-auto max-w-full object-contain object-left ${shadow} ${className}`.trim()}
    />
  );
}
