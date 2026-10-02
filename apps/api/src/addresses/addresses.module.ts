import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { DeliveryModule } from '../delivery/delivery.module';
import { AddressDto, UpdateAddressDto } from './addresses.dto';
import { AddressesService } from './addresses.service';

@ApiTags('addresses')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.addresses.list(auth.user.id);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: AddressDto) {
    return this.addresses.create(auth.user.id, dto);
  }

  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateAddressDto) {
    return this.addresses.update(auth.user.id, id, dto);
  }

  @Post(':id/primary')
  @HttpCode(200)
  makePrimary(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.addresses.makePrimary(auth.user.id, id);
  }

  @Delete(':id')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.addresses.remove(auth.user.id, id);
  }
}

@Module({
  imports: [AuthModule, DeliveryModule],
  controllers: [AddressesController],
  providers: [AddressesService],
})
export class AddressesModule {}
