import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Release 6 «Сайт»: /api/sitemap.xml for search engines (nginx serves it as https://vitalo.uz/sitemap.xml).
 * Products on sale, categories, brands with a page — the site's own addresses (slug).
 */
@ApiExcludeController()
@Controller()
export class SitemapController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  async sitemap(): Promise<string> {
    const site = (this.config.get<string>('SITE_URL') ?? 'https://vitalo.uz').replace(/\/+$/, '');
    const [products, categories, brands] = await Promise.all([
      this.prisma.products.findMany({ where: { status: 'active', is_test: false, slug: { not: null } }, select: { slug: true, updated_at: true } }),
      this.prisma.categories.findMany({ where: { status: 'active', merged_into_id: null }, select: { slug: true } }),
      this.prisma.brands.findMany({ where: { status: 'active', is_test: false, slug: { not: null } }, select: { slug: true, updated_at: true } }),
    ]);
    const url = (path: string, lastmod?: Date, priority = '0.6') =>
      `<url><loc>${esc(site + path)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}<priority>${priority}</priority></url>`;
    const rows = [
      url('/', undefined, '1.0'),
      url('/catalog', undefined, '0.8'),
      ...categories.map((c) => url(`/catalog/products?category=${encodeURIComponent(c.slug)}`, undefined, '0.7')),
      ...brands.map((b) => url(`/brand/${encodeURIComponent(b.slug!)}`, b.updated_at, '0.5')),
      ...products.map((p) => url(`/product/${encodeURIComponent(p.slug!)}`, p.updated_at, '0.8')),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
  }
}
