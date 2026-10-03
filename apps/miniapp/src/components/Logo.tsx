/** Brand mark. Text logo in Montserrat Bold until the logo files are added to public/brand/. */
export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return <span className={`logo logo-${size}`}>VITALO</span>;
}
