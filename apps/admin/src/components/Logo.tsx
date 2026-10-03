import { BRAND } from '../lib/brand';

/** Brand logo from apps/miniapp/public/brand/ (any format); text "VITALO" if the file is missing. */
export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  if (BRAND.logo) return <img className={`logo-img logo-img-${size}`} src={BRAND.logo} alt="VITALO" />;
  return <span className={`logo logo-${size}`}>VITALO</span>;
}
