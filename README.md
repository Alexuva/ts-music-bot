# ts-music-bot

A music bot for TeamSpeak integrated with Lidarr and Tubifarry. Search, download and play music directly from the TeamSpeak chat.

## Features

- Music playback using Opus codec at 96kbps
- Lidarr integration for music library management
- Playback queue
- Volume control
- Automatic webhook notifications when a download completes
- Artist, album and track search
- Support for artists with non-latin names (Japanese, etc.)

## Requirements

- Docker
- TeamSpeak 6 (client and server)
- Lidarr with Tubifarry configured as download client

> [!NOTE]
> This bot is designed to work with [Tubifarry](https://github.com/TypNull/Tubifarry) as the Lidarr download plugin. Make sure it is installed and configured before proceeding.

- Shared Docker network between the bot and Lidarr

## Installation

### 1. Create a shared Docker network

If you don't already have a shared network with Lidarr, create one:

```bash
docker network create music-network
```

### 2. Get the TeamSpeak API Key

In the TeamSpeak server, go to **Tools → ServerQuery** and generate an API Key for the WebQuery (default port 10080).

> [!WARNING]
> Node.js treats port 10080 as an unsafe port and blocks `fetch` requests to it. It is recommended to map the WebQuery to a different port on the TeamSpeak server side (e.g. `10090`) and use that port in `TS_QUERY_PORT`. In Docker you can expose it like this:
> ```yaml
> ports:
>   - "10090:10080"
> ```

### 3. Configure environment variables

Copy `.env-template` to `.env` and fill in the values:

```env
# TeamSpeak
TS_HOST=your-ts-server.com
TS_PORT=9987
TS_QUERY_PORT=10090
TS_API_KEY=your-api-key
TS_NICKNAME=BotName
TS_SERVER_PASSWORD=optional-password

# Lidarr
LIDARR_URL=http://lidarr:8686
LIDARR_API_KEY=your-lidarr-api-key

# Webhook
WEBHOOK_PORT=3000

# Bot
BOT_COMMAND_PREFIX=!
BOT_AFK_CHANNEL=AFK
```

### 4. Docker Compose

```yaml
services:
  ts-music-bot:
    image: alejandrohernandezrosa/ts-music-bot
    container_name: ts-music-bot
    restart: unless-stopped
    volumes:
      - ${PATH_TO_DATA}:/data
    environment:
      - TS_HOST=your-ts-server.com
      - TS_PORT=9987
      - TS_QUERY_PORT=10090
      - TS_API_KEY=your-api-key
      - TS_NICKNAME=BotName
      - TS_SERVER_PASSWORD=
      - LIDARR_URL=http://lidarr:8686
      - LIDARR_API_KEY=your-lidarr-api-key
      - WEBHOOK_PORT=3000
      - BOT_COMMAND_PREFIX=!
      - BOT_AFK_CHANNEL=AFK
    networks:
      - music-network

networks:
  music-network:
    external: true
```

### 5. Configure the webhook in Lidarr

1. Go to **Settings → Connect → +** and choose **Webhook**
2. URL: `http://ts-music-bot:3000/webhook`
3. Enable events: **On Grab** and **On Release Import**
4. Save and use the **Test** button to verify the connection

### 6. Start the bot

```bash
docker compose up -d
```

## Commands

| Command | Description |
|---|---|
| `!play <artist> - <track>` | Play a track |
| `!search <artist>` | Add an artist to the library |
| `!download <artist> - <track>` | Download a track |
| `!queue <artist> - <track>` | Add to the queue |
| `!queue` | Show current queue |
| `!info <artist>` | Browse albums and tracks |
| `!pick <n>` | Select from a list of results |
| `!skip` | Skip current track |
| `!stop` | Stop and clear the queue |
| `!move <channel>` | Move bot to a channel |
| `!vol <0-100>` | Set volume |
| `!np` | Show now playing |
| `!status` | Show Lidarr download queue |
| `!help` | Show help |

## Credits

The TeamSpeak 6 protocol implementation in `src/tslib/` is based on [ts6-manager](https://github.com/clusterzx/ts6-manager) by [clusterzx](https://github.com/clusterzx), licensed under MIT. It has been modified to fit the needs of this project.

## License

MIT — see [LICENSE](./LICENSE).

## Local build

```bash
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```
