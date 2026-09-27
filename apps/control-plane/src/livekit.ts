import { Inject, Injectable } from "@nestjs/common";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { CONFIG, type AppConfig } from "./config.js";

export abstract class RoomGateway {
  abstract create(room: string, sessionId: string): Promise<void>;
  abstract token(room: string, identity: string): Promise<string>;
  abstract remove(room: string): Promise<void>;
}

@Injectable()
export class LiveKitGateway extends RoomGateway {
  private readonly rooms: RoomServiceClient;
  private readonly dispatch: AgentDispatchClient;
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    super();
    const url = new URL(config.LIVEKIT_URL);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.rooms = new RoomServiceClient(url.href, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
    this.dispatch = new AgentDispatchClient(url.href, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  }
  async create(room: string, sessionId: string) {
    await this.rooms.createRoom({ name: room, metadata: JSON.stringify({ sessionId }), emptyTimeout: 300 });
    await this.dispatch.createDispatch(room, this.config.LIVEKIT_AGENT_NAME, { metadata: JSON.stringify({ sessionId }) });
  }
  async token(room: string, identity: string) {
    const token = new AccessToken(this.config.LIVEKIT_API_KEY, this.config.LIVEKIT_API_SECRET, {
      identity, ttl: this.config.LIVEKIT_TOKEN_TTL_SECONDS,
    });
    token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    return token.toJwt();
  }
  async remove(room: string) {
    const existing = await this.rooms.listRooms([room]);
    if (existing.some((item) => item.name === room)) await this.rooms.deleteRoom(room);
  }
}
