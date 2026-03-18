export type WebhookConfig = {
  port: number;
}
export type TeamspeakConfig = {
  host: string;
  port: number;
  query_port: number;
  api_key: string;
  nickname: string;
  server_password: string;
}
export type LidarrConfig = {
  url: string;
  api_key: string;
}
export type BotConfig = {
  command_prefix: string;
  afk_channel: string;
}
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class Config {

  private static env( key: string, fallback?:string ): string {
    const value: string|undefined = process.env[key] ?? fallback;
    if (value === null || value === undefined) throw new ConfigError(`Missing environment variable: ${key}`);
    return value;
  }
  static get teamspeak(): TeamspeakConfig {
    return {
      host: this.env('TS_HOST'),
      port: parseInt(this.env('TS_PORT')),
      query_port: parseInt(this.env('TS_QUERY_PORT')),
      api_key: this.env('TS_API_KEY'),
      nickname: this.env('TS_NICKNAME'),
      server_password: this.env('TS_SERVER_PASSWORD', ''),
    }
  }
  static get lidarr(): LidarrConfig {
    return {
      url: this.env('LIDARR_URL'),
      api_key: this.env('LIDARR_API_KEY'),
    };
  }
  static get bot(): BotConfig {
    return {
      command_prefix: this.env('BOT_COMMAND_PREFIX', '!'),
      afk_channel: this.env('BOT_AFK_CHANNEL', 'AFK'),
    };
  }
  static get webhook(): WebhookConfig {
    return {
      port: parseInt(this.env('WEBHOOK_PORT', '3000')),
    }
  }

}