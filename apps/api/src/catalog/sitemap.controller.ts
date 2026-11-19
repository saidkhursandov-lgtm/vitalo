import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import type { CategoryNode } from './category-tree';

const flat = (nodes: CategoryNode[]): string[] => nodes.flatMap((n) => [n.slug, ...flat(n.children)]);
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
    private readonly catalog: CatalogService,
  ) {}

  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  async sitemap(): Promise<string> {
    const site = (this.config.get<string>('SITE_URL') ?? 'https://vitalo.uz').replace(/\/+$/, '');
    const [products, categories, brands, bundles] = await Promise.all([
      this.prisma.products.findMany({ where: { status: 'active', is_test: false, slug: { not: null } }, select: { slug: true, updated_at: true } }),
      // the same tree customers see: only categories with products on sale (an empty one has no page on the site)
      this.catalog.getCategoryTrees().then((t) => [...new Set(flat([...t.need, ...t.product_type]))].map((slug) => ({ slug }))),
      this.prisma.brands.findMany({ where: { status: 'active', is_test: false, slug: { not: null } }, select: { slug: true, updated_at: true } }),
      this.prisma.bundles.findMany({ where: { is_active: true }, select: { slug: true, updated_at: true } }),
    ]);
    const url = (path: string, lastmod?: Date, priority = '0.6') =>
      `<url><loc>${esc(site + path)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}<priority>${priority}</priority></url>`;
    const rows = [
      url('/', undefined, '1.0'),
      url('/catalog', undefined, '0.8'),
      url('/brands', undefined, '0.6'),
      url('/sets', undefined, '0.6'),
      url('/ai', undefined, '0.6'),
      // the site's own addresses (6.6): /catalog/<slug>, not the Mini App's /catalog/products?category=
      ...categories.map((c) => url(`/catalog/${encodeURIComponent(c.slug)}`, undefined, '0.7')),
      ...bundles.map((b) => url(`/set/${encodeURIComponent(b.slug)}`, b.updated_at, '0.6')),
      ...brands.map((b) => url(`/brand/${encodeURIComponent(b.slug!)}`, b.updated_at, '0.5')),
      ...products.map((p) => url(`/product/${encodeURIComponent(p.slug!)}`, p.updated_at, '0.8')),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
  }
}
