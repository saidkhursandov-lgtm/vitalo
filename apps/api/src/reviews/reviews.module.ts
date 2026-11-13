import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { REVIEW_PHOTO_MAX_BYTES, REVIEW_PHOTOS_MAX, REVIEW_TAGS, REVIEW_TEXT_MAX } from './review-rules';
import { ReviewsService } from './reviews.service';

/** multipart sends everything as text: "true" / "5" / tags as "effect,easy" or several fields. */
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';
const toTags = ({ value }: { value: unknown }) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((s) => String(s).trim()).filter(Boolean);

export class CreateReviewDto {
  @ApiProperty() @IsUUID() order_id!: string;
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) @Type(() => Number) @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiPropertyOptional({ enum: REVIEW_TAGS, isArray: true }) @IsOptional() @Transform(toTags) @IsArray() @ArrayMaxSize(REVIEW_TAGS.length) @IsIn(REVIEW_TAGS, { each: true }) tags?: string[];
  @ApiProperty({ maxLength: REVIEW_TEXT_MAX }) @IsString() @MaxLength(REVIEW_TEXT_MAX) text!: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @Transform(toBool) @IsBoolean() show_name?: boolean;
}

class PageQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}

/** 3.10-Б: the customer's side — what can be reviewed, the form, the own reviews. */
@ApiTags('reviews')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('pending')
  pending(@CurrentAuth() auth: AuthContext, @Query('order_id') orderId?: string) {
    return this.reviews.reviewable(auth.user.id, orderId && /^[0-9a-f-]{36}$/i.test(orderId) ? orderId : undefined);
  }

  @Get('form')
  form(@CurrentAuth() auth: AuthContext) {
    return this.reviews.formInfo(auth.user.id);
  }

  @Get('mine')
  mine(@CurrentAuth() auth: AuthContext) {
    return this.reviews.mine(auth.user.id);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('photos', REVIEW_PHOTOS_MAX, { storage: memoryStorage(), limits: { fileSize: REVIEW_PHOTO_MAX_BYTES, files: REVIEW_PHOTOS_MAX } }))
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateReviewDto, @UploadedFiles() files: Express.Multer.File[] = []) {
    return this.reviews.create(
      auth.user.id,
      { order_id: dto.order_id, product_id: dto.product_id, rating: dto.rating, tags: dto.tags, text: dto.text, show_name: dto.show_name ?? true },
      files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, size: f.size })),
    );
  }
}

/** 3.10-Б: published reviews on the product card (public, like the catalogue). */
@ApiTags('reviews')
@Controller('catalog/products/:id/reviews')
export class ProductReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Param('id', new ParseUUIDPipe()) id: string, @Query() q: PageQuery) {
    return this.reviews.forProduct(id, q.page ?? 1);
  }
}

@Global()
@Module({ imports: [AuthModule], controllers: [ReviewsController, ProductReviewsController], providers: [ReviewsService], exports: [ReviewsService] })
export class ReviewsModule {}
