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
    return (
      <div className={`overflow-hidden ${className}`.trim()}>
        <img
          src={src}
          alt="Lumeo"
          className={`h-auto w-[140px] max-w-none object-contain object-left ${shadow}`}
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
