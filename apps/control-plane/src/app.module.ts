import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { CONFIG, type AppConfig } from "./config.js";
import { SqliteStorage } from "./storage/sqlite.js";
import { RedisLiveSessionStore } from "./storage/redis.js";
import { CourseRepo, LiveSessionStore, PatternRepo, ProfileRepo, SessionRepo } from "./storage/ports.js";
import { AuthGuard } from "./auth.js";
import { ProfileService, MemoryService } from "./memory.js";
import { CourseService } from "./catalog.js";
import { SessionService } from "./sessions.js";
import { LiveKitGateway, RoomGateway } from "./livekit.js";
import { CourseController, ProfileController, ProgressController, SessionController } from "./controllers.js";
import { ApiExceptionFilter } from "./errors.js";

@Global()
@Module({})
class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] };
  }
}

@Module({
  providers: [
    SqliteStorage,
    ...[ProfileRepo, CourseRepo, SessionRepo, PatternRepo].map((provide) => ({ provide, useExisting: SqliteStorage })),
    { provide: LiveSessionStore, useClass: RedisLiveSessionStore },
  ],
  exports: [ProfileRepo, CourseRepo, SessionRepo, PatternRepo, LiveSessionStore],
})
export class StorageModule {}

@Global()
@Module({ imports: [JwtModule.register({})], providers: [AuthGuard], exports: [AuthGuard, JwtModule] })
export class AuthModule {}

@Module({ imports: [StorageModule], providers: [MemoryService], exports: [MemoryService] })
export class MemoryModule {}

@Module({
  imports: [StorageModule, MemoryModule], providers: [ProfileService],
  controllers: [ProfileController], exports: [ProfileService],
})
export class ProfileModule {}

@Module({
  imports: [StorageModule, ProfileModule], providers: [CourseService],
  controllers: [CourseController], exports: [CourseService],
})
export class CourseModule {}

@Module({
  imports: [StorageModule, ProfileModule], controllers: [ProgressController],
})
export class ProgressModule {}

@Module({
  imports: [StorageModule, ProfileModule, CourseModule, MemoryModule],
  providers: [SessionService, { provide: RoomGateway, useClass: LiveKitGateway }],
  controllers: [SessionController],
})
export class SessionModule {}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.register(config), AuthModule, ProfileModule, CourseModule, SessionModule, ProgressModule],
    };
  }
}

export function configureApp(app: INestApplication, config: AppConfig) {
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: config.WEB_ORIGINS, credentials: true });
  app.enableShutdownHooks();
}
