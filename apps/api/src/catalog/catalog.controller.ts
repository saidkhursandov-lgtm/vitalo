import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { ListProductsQuery, SearchQuery } from './catalog.dto';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiQuery({ name: 'include_empty', required: false, description: 'true — вместе с пустыми категориями (админка)' })
  categories(@Query('include_empty') includeEmpty?: string) {
    return this.catalog.getCategoryTrees(includeEmpty === 'true');
  }

  @Get('brands')
  brands() {
    return this.catalog.listBrands();
  }

  /** 2.2: «Проверенные бренды» — only brands with products in stock. Must stay before brands/:slug. */
  @Get('brands/showcase')
  brandShowcase() {
    return this.catalog.brandShowcase();
  }

  @Get('brands/:slug')
  brand(@Param('slug') slug: string) {
    return this.catalog.brandPage(slug);
  }

  @Get('forms')
  forms() {
    return this.catalog.listForms();
  }

  /** 6а-Б: «Популярное» (in stock) and «Новинки» (in stock or «под заказ», no repeats) for the home page. */
  @Get('home')
  home() {
    return this.catalog.home();
  }

  @Get('products')
  products(@Query() q: ListProductsQuery) {
    return this.catalog.listProducts(q);
  }

  /** Must stay before products/:id. */
  @Get('products/count')
  count(@Query() q: ListProductsQuery) {
    return this.catalog.countProducts(q);
  }

  @Get('texts')
  texts() {
    return this.catalog.texts();
  }

  @Get('products/:id')
  product(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getProduct(id);
  }

  @Get('search')
  search(@Query() q: SearchQuery) {
    return this.catalog.search(q);
  }
}
