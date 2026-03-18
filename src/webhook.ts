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
      if (req.body["eventType"] !==  'Download') return res.sendStatus(200);
      if (!req.body["albums"]) return res.sendStatus(200);

      const [{id, title}] = req.body["albums"];
      if (!this.petitions.has(id)) return res.sendStatus(200);

      const clid: string = this.petitions.get(id)!;
      const { name } = req.body["artist"];

      if (!this.bot) return res.sendStatus(200);

      this.bot.sendMessage(clid, `✓ [b]${title}[/b] de [b]${name}[/b] ya está disponible.\nUsa [b]!play ${name} - <cancion>[/b] para escucharla.`);
      this.petitions.delete(id);

      console.log(req.body);
      res.sendStatus(200);
    });
  }

  public addPetition(albumId: number, clid: string): void{
    this.petitions.set(albumId, clid);
  }

}