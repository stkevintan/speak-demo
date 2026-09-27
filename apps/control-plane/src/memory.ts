import { Inject, Injectable, Logger } from "@nestjs/common";
import { PatternRepo, ProfileRepo } from "./storage/ports.js";
import { Profile, type ProfilePatch } from "@rehearsal/contracts";

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  constructor(@Inject(PatternRepo) private readonly repo: PatternRepo) {}
  async recall(userId: string) {
    try { return await this.repo.recall(userId); }
    catch {
      this.logger.warn("Pattern recall unavailable; continuing without historical memory");
      return [];
    }
  }
  async recordPending() {
    try { await this.repo.applyPending(); }
    catch { this.logger.warn("Pattern updates pending; will retry on next recovery sweep"); }
  }
}
@Injectable()
export class ProfileService {
  constructor(
    @Inject(ProfileRepo) private readonly repo: ProfileRepo,
    @Inject(MemoryService) private readonly memory: MemoryService,
  ) {}
  async get(userId: string) {
    const profile = await this.repo.getOrCreate(userId);
    return Profile.parse({ ...profile, patterns: await this.memory.recall(userId) });
  }
  async patch(userId: string, patch: ProfilePatch) {
    const profile = await this.repo.patch(userId, patch);
    return Profile.parse({ ...profile, patterns: await this.memory.recall(userId) });
  }
}
