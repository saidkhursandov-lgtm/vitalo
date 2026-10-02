import { Global, Module } from '@nestjs/common';
import { NotificationWorker } from './notification-worker';
import { NotificationsService } from './notifications.service';
import { HttpTelegramSender, TELEGRAM_SENDER } from './telegram-sender';

/** Telegram notifications: queue (NotificationsService) + delivery with retries (NotificationWorker). */
@Global()
@Module({
  providers: [NotificationsService, NotificationWorker, { provide: TELEGRAM_SENDER, useClass: HttpTelegramSender }],
  exports: [NotificationsService, NotificationWorker],
})
export class NotificationsModule {}
