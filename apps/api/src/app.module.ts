/**
 * Module racine GestHost API (README §61 : apps/api NestJS + Drizzle + PostgreSQL).
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth';
import { AuditModule } from './audit/audit';
import { OutboxModule } from './outbox/outbox';
import { CatalogModule } from './catalog/catalog';
import { PricingModule } from './pricing/pricing';
import { InventoryModule } from './inventory/availability';
import { GuestsModule } from './guests/guests';
import { ReservationsModule } from './reservations/reservations';
import { StaysModule } from './stays/stays';
import { FoliosModule } from './billing/folios';
import { InvoicesModule } from './billing/invoices';
import { FneModule } from './fne/fne';
import { CashModule } from './cash/cash';
import { HousekeepingModule } from './housekeeping/housekeeping';
import { MaintenanceModule } from './maintenance/maintenance';
import { NightAuditModule } from './nightaudit/nightaudit';
import { ReportsModule } from './reports/reports';
import { NotificationsModule } from './notifications/notifications';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AuditModule,
    OutboxModule,
    CatalogModule,
    PricingModule,
    InventoryModule,
    GuestsModule,
    ReservationsModule,
    StaysModule,
    FoliosModule,
    InvoicesModule,
    FneModule,
    CashModule,
    HousekeepingModule,
    MaintenanceModule,
    NightAuditModule,
    ReportsModule,
    NotificationsModule,
  ],
})
export class AppModule {}
