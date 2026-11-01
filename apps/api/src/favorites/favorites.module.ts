import { Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { listInclude, ProductListItem, toProductListItem } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from '../promo/campaigns.service';
import { PromoModule } from '../promo/promo.module';

@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  /** Newest first. Products that stopped being sold (archived/hidden) are not shown. */
  async list(userId: string): Promise<ProductListItem[]> {
    const rows = await this.prisma.favorites.findMany({
      where: { user_id: userId, product: { status: 'active' } },
      orderBy: { created_at: 'desc' },
      include: { product: { include: listInclude } },
    });
    return this.campaigns.decorate(rows.map((r) => toProductListItem(r.product)));
  }

  async ids(userId: string): Promise<string[]> {
    const rows = await this.prisma.favorites.findMany({
      where: { user_id: userId, product: { status: 'active' } },
      select: { product_id: true },
    });
    return rows.map((r) => r.product_id);
  }

  /** Idempotent: adding twice keeps one row. */
  async add(userId: string, productId: string): Promise<void> {
    const product = await this.prisma.products.findFirst({ where: { id: productId, status: 'active' } });
    if (!product) throw new NotFoundException('Product not found');
    await this.prisma.favorites.upsert({
      where: { user_id_product_id: { user_id: userId, product_id: productId } },
      create: { user_id: userId, product_id: productId },
      update: {},
    });
  }

  /** Idempotent: removing something that is not there is fine. */
  async remove(userId: string, productId: string): Promise<void> {
    await this.prisma.favorites.deleteMany({ where: { user_id: userId, product_id: productId } });
  }
}

@ApiTags('favorites')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.favorites.list(auth.user.id);
  }

  /** Just the product ids, to draw hearts on product cards. */
  @Get('ids')
  ids(@CurrentAuth() auth: AuthContext) {
    return this.favorites.ids(auth.user.id);
  }

  @Put(':productId')
  @HttpCode(204)
  async add(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    await this.favorites.add(auth.user.id, productId);
  }

  @Delete(':productId')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    await this.favorites.remove(auth.user.id, productId);
  }
}

@Module({ imports: [AuthModule, PromoModule], controllers: [FavoritesController], providers: [FavoritesService] })
export class FavoritesModule {}
