import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule, configureApp } from "./app.module.js";
import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config));
  configureApp(app, config);
  await app.listen(config.PORT, config.HOST);
}
void main().catch(() => {
  Logger.error("Control-plane startup failed; check configuration and required dependencies");
  process.exitCode = 1;
});
