import lightThemeLogo from '../assets/lumeo-logo-user-transparent.png';
import darkThemeLogo from '../assets/lumeo_logo_darktheme.png';
import swirlLogo from '../assets/lumeo-logo-swirl-only.png';
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
    return (
      <div className={`flex items-center justify-center ${className}`.trim()}>
        <img
          src={swirlLogo}
          alt="Lumeo"
          className={`h-auto max-w-full object-contain ${shadow}`}
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
