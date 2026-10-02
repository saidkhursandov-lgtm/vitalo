import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ListProductsQuery, SearchQuery } from './catalog.dto';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories() {
    return this.catalog.getCategoryTrees();
  }

  @Get('brands')
  brands() {
    return this.catalog.listBrands();
  }

  @Get('forms')
  forms() {
    return this.catalog.listForms();
  }

  @Get('products')
  products(@Query() q: ListProductsQuery) {
    return this.catalog.listProducts(q);
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
