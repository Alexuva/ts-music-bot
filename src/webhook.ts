import express, { Express } from 'express';
import { MusicBot } from "./bot.js";
import type { WebhookConfig} from "./config.js";
export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

export class Server {

  private readonly port: number;
  private readonly app: Express;

  bot: MusicBot|null = null;
  private petitions: Map<number, string> = new Map();

  constructor({port}: WebhookConfig) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.start();
  }

  set setBot(bot: MusicBot) {
    this.bot = bot;
  }

  public start(): void {
    this.loadRoutes();

    this.app.listen(
      this.port,
      () => console.log(`[Webhook] Server listening on port ${this.port}`)
    );
  }

  private loadRoutes(): void {
    this.app.post('/webhook', (req, res) => {
      const eventType: string = req.body["eventType"];
      console.log('[Webhook] Received:', eventType);
      console.log(req.body);

      res.sendStatus(200);

      if (!this.bot) return;

      const albumData = req.body["albums"]?.[0] ?? req.body["album"];
      if (!albumData) return;

      const { id, title } = albumData;
      const { name } = req.body["artist"];
      const clid: string | undefined = this.petitions.get(id);

      if (!clid) return;

      if (eventType === 'Grab') this.bot.sendMessage(clid, `⏳ Descargando **${title}** de **${name}**...`);
      if (eventType === 'Download') {
        this.bot.sendMessage(clid, `✅ **${title}** de **${name}** ya está disponible.\nUsa **!play ${name} - <cancion>** para escucharla.`);
        this.petitions.delete(id);
      }
    });
  }

  public addPetition(albumId: number, clid: string): void{
    this.petitions.set(albumId, clid);
  }

}