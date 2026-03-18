import { Config, ConfigError } from './config.js';
import { LidarrClient, LidarrError } from './lidarr.js';
import { MusicBot } from './bot.js';
import { Server } from "./webhook.js";

try {
  const lidarr = new LidarrClient(Config.lidarr);
  const webhook = new Server(Config.webhook);
  const bot = new MusicBot(Config.bot, Config.teamspeak, lidarr, webhook);
  webhook.setBot = bot;

  console.log('[Main] Starting bot...');
  await bot.start();
  console.log('[Main] Bot running');

} catch (e: unknown) {

  if (e instanceof ConfigError) console.error(`[${e.name}] Error starting bot:\n ${e.message}`);
  if (e instanceof LidarrError) console.error(`[${e.name}] Error in Lidarr implementation:\n ${e.message}`)
  if (e instanceof Error) console.error(`[Fatal error]: \n ${e.message}`);

  console.error(`[Unkown error]: \n ${e}`)

  process.exit(1);
}

