import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { OrdersModule } from '../orders/orders.module';
import { RETURN_COMMENT_MAX, RETURN_PHOTO_MAX_BYTES, RETURN_PHOTOS_MAX, RETURN_REASONS_OPEN } from './return-rules';
import { ReturnsService } from './returns.service';

/** multipart sends text: items as JSON «[{"order_item_id":"…","qty":1}]». */
const toItems = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((x: { order_item_id?: unknown; qty?: unknown }) => ({ order_item_id: String(x.order_item_id ?? ''), qty: Number(x.qty) })) : [];
  } catch {
    return [];
  }
};

export class CreateReturnDto {
  @ApiProperty() @IsUUID() order_id!: string;
  @ApiProperty({ enum: RETURN_REASONS_OPEN }) @IsIn([...RETURN_REASONS_OPEN]) reason!: string;
  @ApiPropertyOptional({ maxLength: RETURN_COMMENT_MAX }) @IsOptional() @IsString() @MaxLength(RETURN_COMMENT_MAX) comment?: string;
  @ApiProperty({ description: 'JSON: [{"order_item_id":"…","qty":1}]' }) @Transform(toItems) @IsArray() items!: { order_item_id: string; qty: number }[];
}

/** 3.10-В: «Вернуть товар» — the customer's side. */
@ApiTags('returns')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get('order/:orderId')
  forOrder(@CurrentAuth() auth: AuthContext, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.returns.forOrder(auth.user.id, orderId);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('photos', RETURN_PHOTOS_MAX, { storage: memoryStorage(), limits: { fileSize: RETURN_PHOTO_MAX_BYTES, files: RETURN_PHOTOS_MAX } }))
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateReturnDto, @UploadedFiles() files: Express.Multer.File[] = []) {
    return this.returns.create(
      auth.user.id,
      { order_id: dto.order_id, reason: dto.reason, comment: dto.comment, items: dto.items },
      files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, size: f.size })),
    );
  }
}

@Global()
@Module({ imports: [AuthModule, OrdersModule], controllers: [ReturnsController], providers: [ReturnsService], exports: [ReturnsService] })
export class ReturnsModule {}
