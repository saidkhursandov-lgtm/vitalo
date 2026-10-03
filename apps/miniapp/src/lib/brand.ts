/** Logo and icon URLs chosen at build time from public/brand/ (see brand-plugin.ts). null = file missing. */
declare const __BRAND__: { logo: string | null; icon: string | null; iconSquare: string | null } | undefined;

export const BRAND = typeof __BRAND__ !== 'undefined' ? __BRAND__ : { logo: null, icon: null, iconSquare: null };
