import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/lang';

/** Release 6.6: search engines index the catalog; personal pages stay out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/account', '/cart', '/checkout', '/order/', '/login', '/review/', '/api/'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
