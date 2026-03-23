import {generateIdentity, IdentityData, Ts3Client} from "./tslib/index.js";
import {AudioPipeline, FRAME_MS} from "./audio/pipeline.js";
import type {BotConfig, TeamspeakConfig} from "./config.js";
import type {LidarrAlbum, LidarrArtist, LidarrClient, LidarrQueueItem, LidarrTrack} from "./lidarr.js";
import {Server} from "./webhook.js";

type PendingType = 'info_artist' | 'new_artist' | 'info_album' | 'info_tracks';

const PAGE_SIZE = 10;

interface PendingSearch {
  type: PendingType;
  results: Array<{ label: string; data: LidarrArtist | LidarrTrack | LidarrAlbum }>;
  offset: number;
}

interface QueueItem {
  track: LidarrTrack;
  trackFilePath: string;
}


export class MusicBot {

  private client: Ts3Client;
  private pipeline: AudioPipeline;
  private playing: boolean = false;
  private isPlaying: boolean = false;
  private volume: number = 100;
  private currentTrack: string | null = null;
  private pendingSearches: Map<String, PendingSearch> = new Map<string, PendingSearch>();
  private playQueue: QueueItem[] = [];

  constructor(
    private bot: BotConfig,
    private teamspeak: TeamspeakConfig,
    private lidarr: LidarrClient,
    private webhook: Server
  ) {
    this.client = new Ts3Client();
    this.pipeline = new AudioPipeline();
  }

  async start(): Promise<void> {
    const identity: IdentityData = await generateIdentity();
    console.log('[Bot] Connecting to TeamSpeak...');
    await this.client.connect({
      host: this.teamspeak.host,
      port: this.teamspeak.port,
      identity,
      nickname: this.teamspeak.nickname,
      serverPassword: this.teamspeak.server_password,
    });
    console.log('[Bot] Connected!');
    await this.moveToChannel('AFK');

    this.client.on('textMessage', async (params: Record<string, string>): Promise<void> => {
      const botClid: number = this.client.getClientId();
      if (params.invokerid === String(botClid)) return;

      const msg: string = (params.msg || '').trim();
      if (!msg.startsWith(this.bot.command_prefix)) return;

      const parts: string[] = msg.slice(1).split(/\s+/);
      const command: string = parts[0].toLowerCase();
      const args: string = parts.slice(1).join(' ').trim();
      const clid: string = params.invokerid;

      try {
        await this.handleCommand(command, args, clid);
      } catch (err: any) {
        console.error(`[Bot] Error handling !${command}:`, err.message);
        this.sendMessage(clid, `❌ **Error:** ${err.message}`);
      }
    });

    this.client.on('error', (err: Error): void => {
      console.error('[Bot] Error:', err.message);
    });

    this.client.on('disconnected', (): void => {
      console.log('[Bot] Disconnected. Reconnecting in 5s...');
      this.playing = false;
      this.isPlaying = false;
      this.playQueue = [];
      this.currentTrack = null;
      setTimeout(() => this.reconnect(), 5000);
    });

    this.client.on('clientMoved', (reasonId: number): void => {
      if (reasonId === 4 && !this.isPlaying) {
        this.moveToChannel(this.bot.afk_channel);
      }
    });
  }

  /**
   * Reconnects to the server.
   * @private
   */
  private async reconnect(): Promise<void> {
    try {
      console.log('[Bot] Reconnecting...');
      const identity: IdentityData = await generateIdentity();
      await this.client.connect({
        host: this.teamspeak.host,
        port: this.teamspeak.port,
        identity,
        nickname: this.teamspeak.nickname,
        serverPassword: this.teamspeak.server_password,
      });
      console.log('[Bot] Reconnected!');
      await this.moveToChannel(this.bot.afk_channel);
    } catch (err: any) {
      console.error('[Bot] Reconnect failed:', err.message, '— retrying in 5s');
      setTimeout(() => this.reconnect(), 5000);
    }
  }

  /**
   * Handles a command.
   * @param command String with the command name.
   * @param args String with the arguments for the command.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleCommand(command: string, args: string, clid: string): Promise<void> {
    switch (command) {
      case 'move':          await this.handleMove(args, clid); break;
      case 'play':          await this.handlePlay(args, clid); break;
      case 'library':       await this.handleLibrary(clid); break;
      case 'pick':          await this.handlePick(args, clid); break;
      case 'more':          await this.handleMore(clid); break;
      case 'skip':          await this.handleSkip(clid); break;
      case 'stop':          this.handleStop(); break;

      case 'vol':
      case 'volume':        this.handleVolume(args, clid); break;

      case 'np':
      case 'nowplaying':    this.handleNowPlaying(clid); break;

      case 'queue':         await this.handleQueue(clid); break;
      case 'status':        await this.handleStatus(clid); break;
      case 'help':          this.handleHelp(clid); break;
    }
  }

  /**
   * Moves Bot to a specific channel.
   * @param channelName String with the name of the channel to move to.
   * @private
   */
  private async moveToChannel(channelName: string): Promise<void> {
    try {
      const res: Response = await fetch(
        `http://${this.teamspeak.host}:${this.teamspeak.query_port}/1/channellist`,
        { headers: { 'x-api-key': this.teamspeak.api_key } }
      );
      const data = await res.json() as { body: Array<{ cid: string; channel_name: string }> };
      const channel: { cid: string, channel_name: string } | undefined = data.body?.find((c: { cid: string, channel_name: string }): boolean => c.channel_name === channelName);
      if (!channel) return;

      const botClid: number = this.client.getClientId();
      await fetch(
        `http://${this.teamspeak.host}:${this.teamspeak.query_port}/1/clientmove?clid=${botClid}&cid=${channel.cid}`,
        { headers: { 'x-api-key': this.teamspeak.api_key } }
      );
    } catch (err) {
      console.error('[Bot] Failed to move to channel:', err);
    }
  }

  /**
   * Sends a message to the client.
   * @param clid String with the client ID of the client to send the message to.
   * @param message String with the message to send.
   */
  public sendMessage(clid: string, message: string): void {
    const escaped: string = message
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\p')
      .replace(/\n/g, '\\n\\n')
      .replace(/ /g, '\\s');
    const cmd = `sendtextmessage targetmode=1 target=${clid} msg=${escaped}`;
    this.client.sendCommand(cmd);
  }

  /**
   * Shows albums of an artist.
   * @param artist LidarrArtist object with the artist data.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async showAlbums(artist: LidarrArtist, clid: string): Promise<void> {
    const albums: LidarrAlbum[] = await this.lidarr.getAlbums(artist.id);

    if (albums.length === 0) {
      this.sendMessage(clid, `⚠️ **${artist.artistName}** no tiene álbumes en la biblioteca.`);
      return;
    }

    const options = albums.map((a: LidarrAlbum, i: number) => ({
      label: `${i + 1}. ${a.title} (${a.releaseDate?.substring(0, 4) ?? '?'})`,
      data: a as LidarrAlbum
    }));

    this.pendingSearches.set(clid, { type: 'info_album', results: options, offset: 0 });
    const page = options.slice(0, PAGE_SIZE);
    const hasMore = options.length > PAGE_SIZE;
    const footer = hasMore
      ? `Usa **${this.bot.command_prefix}pick <numero>** para ver las canciones · **${this.bot.command_prefix}more** para ver más`
      : `Usa **${this.bot.command_prefix}pick <numero>** para ver las canciones`;
    this.sendMessage(clid, [`**${artist.artistName} — Álbumes (${options.length}):**`, ...page.map(o => o.label), footer].join('\n'));
  }

  /**
   * Shows tracks of an album.
   * @param album LidarrAlbum object with the album data.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async showTracks(album: LidarrAlbum, clid: string): Promise<void> {
    const tracks: LidarrTrack[] = await this.lidarr.getTracksForAlbum(album.id);

    if (tracks.length === 0) {
      this.sendMessage(clid, `⚠️ No hay canciones para **${album.title}**.`);
      return;
    }

    const options = tracks.map((t: LidarrTrack, i: number) => ({
      label: `${t.hasFile ? '✅' : '⬇️'} ${i + 1}. ${t.title}`,
      data: t as LidarrTrack
    }));

    this.pendingSearches.set(clid, { type: 'info_tracks', results: options, offset: 0 });
    this.sendMessage(clid, [`**${album.title}:**`, ...options.map(o => o.label), `\nUsa **${this.bot.command_prefix}pick <n>** para reproducir\nSi la canción no está descargada, se agregará a la cola para descargar`].join('\n'));
  }

  /**
   * Downloads a track
   * @param result TrackResult object with the track data.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async downloadTrack(result: LidarrTrack, clid: string): Promise<void> {
    await this.lidarr.monitorAlbum(result.albumId);
    await this.lidarr.searchAlbum(result.albumId);
    this.sendMessage(clid, `**${result.title}** en cola para descarga.\nTe aviso cuando esté listo.`);
    if (this.webhook) this.webhook.addPetition(result.albumId, clid);
  }

  /**
   * Adds a track to the queue and starts playing if the queue is empty.
   * @param track LidarrTrack object with the track data.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async addToQueue(track: LidarrTrack, clid: string): Promise<void> {
    const trackFile: { path: string } = await this.lidarr.getTrackFile(track.trackFileId);
    this.playQueue.push({ track, trackFilePath: trackFile.path });
    this.sendMessage(clid, `**+** **${track.title}** añadido a la cola (posición ${this.playQueue.length})`);

    if (!this.isPlaying) {
      await this.moveToUserChannel(clid);
      await this.runQueue(clid);
    }
  }

  /**
   * Plays the queue
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async runQueue(clid: string): Promise<void> {
    if (this.isPlaying) return;
    this.isPlaying = true;

    while (this.playQueue.length > 0) {
      const item: QueueItem = this.playQueue[0];
      this.currentTrack = item.trackFilePath;
      this.sendMessage(clid, `▶ **${item.track.title}**`);
      this.playing = true;
      await this.playFile(item.trackFilePath);
      this.playing = false;
      this.playQueue.shift();
    }

    this.isPlaying = false;
    this.currentTrack = null;
    this.sendMessage(clid, 'Cola terminada.');
  }

  /**
   * Plays a file from the path
   * @param filePath String with the path to the file to play.
   * @private
   */
  private async playFile(filePath: string): Promise<void> {
    const pcm: Buffer<ArrayBufferLike> = await this.pipeline.toPcm(filePath);
    const frames: Buffer<ArrayBufferLike>[] = this.pipeline.splitFrames(pcm);

    const startTime = Date.now();
    for (let i = 0; i < frames.length; i++) {
      if (!this.playing) break;
      const opus: Buffer<ArrayBufferLike> = this.pipeline.encodeFrame(frames[i], this.volume);
      this.client.sendVoice(opus);
      const delay = startTime + (i + 1) * FRAME_MS - Date.now();
      if (delay > 0) {
        await new Promise((r: (value: unknown) => void) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Bot moves to the user channel
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async moveToUserChannel(clid: string): Promise<void> {
    try {
      const res: Response = await fetch(
        `http://${this.teamspeak.host}:${this.teamspeak.query_port}/1/clientinfo?clid=${clid}`,
        { headers: { 'x-api-key': this.teamspeak.api_key } }
      );
      const data = await res.json() as { body: Array<{ cid: string }> };
      const cid: string = data.body?.[0]?.cid;
      if (!cid) return;

      const botClid: number = this.client.getClientId();
      await fetch(
        `http://${this.teamspeak.host}:${this.teamspeak.query_port}/1/clientmove?clid=${botClid}&cid=${cid}`,
        { headers: { 'x-api-key': this.teamspeak.api_key } }
      );
    } catch (err) {
      console.error('[Bot] Failed to move to user channel:', err);
    }
  }

  /**
   * Handles the play command
   * @param query String with the query to search for.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handlePlay(query: string, clid: string): Promise<void> {
    if (!query) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}play <artista>`);
      return;
    }

    this.sendMessage(clid, `**Buscando:** ${query}...`);

    const localArtists = await this.lidarr.searchLocalArtists(query);

    if (localArtists.length === 1) {
      await this.showAlbums(localArtists[0], clid);
      return;
    }

    if (localArtists.length > 1) {
      const options = localArtists.slice(0, 5).map((a: LidarrArtist, i: number) => ({
        label: `${i + 1}. ${a.artistName}`,
        data: a as LidarrArtist
      }));
      this.pendingSearches.set(clid, { type: 'info_artist', results: options, offset: 0 });
      this.sendMessage(clid, [`**Varios artistas encontrados:**`, ...options.map(o => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
      return;
    }

    // Not in local → search MusicBrainz and add
    const results = await this.lidarr.lookupArtists(query);

    if (results.length === 0) {
      this.sendMessage(clid, `⚠️ No se encontró ningún artista con ese nombre.`);
      return;
    }

    if (results.length === 1) {
      const added = await this.addArtistAndNotify(results[0], clid);
      if (added) await this.showAlbums(added, clid);
      return;
    }

    const options = results.slice(0, 5).map((a: LidarrArtist, i: number) => ({
      label: `${i + 1}. ${a.artistName}${a.disambiguation ? ` (${a.disambiguation})` : ''}`,
      data: a as LidarrArtist
    }));
    this.pendingSearches.set(clid, { type: 'new_artist', results: options, offset: 0 });
    this.sendMessage(clid, [`**Varios resultados:**`, ...options.map(o => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
  }

  /**
   * Handles the library command, shows the user the library.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleLibrary(clid: string): Promise<void> {
    const artists = await this.lidarr.getAllArtists();

    if (artists.length === 0) {
      this.sendMessage(clid, '⚠️ La biblioteca está vacía.');
      return;
    }

    const options = artists.map((a: LidarrArtist, i: number) => ({
      label: `${i + 1}. ${a.artistName}`,
      data: a as LidarrArtist
    }));

    this.pendingSearches.set(clid, { type: 'info_artist', results: options, offset: 0 });
    const page = options.slice(0, PAGE_SIZE);
    const hasMore = options.length > PAGE_SIZE;
    const footer = hasMore
      ? `Usa **${this.bot.command_prefix}pick <numero>** para ver álbumes · **${this.bot.command_prefix}more** para ver más`
      : `Usa **${this.bot.command_prefix}pick <numero>** para ver álbumes`;
    this.sendMessage(clid, [`**Biblioteca (${artists.length} artistas):**`, ...page.map(o => o.label), footer].join('\n'));
  }

  /**
   * Handles the stop command, stops playing and clears the queue.
   * @private
   */
  private handleStop(): void {
    this.playing = false;
    this.isPlaying = false;
    this.playQueue = [];
    this.currentTrack = null;
    this.client.sendVoiceStop();
  }

  /**
   * Handles the skip command, skips the current track and plays the next one in the queue.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleSkip(clid: string): Promise<void> {
    if (!this.isPlaying) {
      this.sendMessage(clid, '⚠️ No hay nada reproduciendo.');
      return;
    }
    const current: string|undefined = this.currentTrack?.split('/').pop();
    this.sendMessage(clid, `⏭ Saltando **${current}**`);
    this.playing = false;
  }

  /**
   * Handles the volume command, changes the volume.
   * @param args String with the arguments for the command.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private handleVolume(args: string, clid: string): void {
    if (!args) {
      this.sendMessage(clid, `Volumen: **${this.volume}%**`);
      return;
    }

    const vol: number = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      this.sendMessage(clid, `**Uso:** ${this.bot.command_prefix}vol <0-100>`);
      return;
    }

    this.volume = vol;
    this.sendMessage(clid, `Volumen ajustado a **${vol}%**`);
  }

  /**
   * Add an artist to the library and notify the user
   * @param artist LidarrArtist object with the artist data.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async addArtistAndNotify(artist: LidarrArtist, clid: string): Promise<LidarrArtist | null> {
    this.sendMessage(clid, `Añadiendo **${artist.artistName}**... esto puede tardar unos segundos.`);

    const added = await this.lidarr.addArtist(artist);
    if (!added.id) {
      this.sendMessage(clid, `Error al agregar **${artist.artistName}**.`);
      return null;
    }

    let tracksLoaded = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const albums = await this.lidarr.getAlbums(added.id);
      if (albums.length === 0) continue;
      const tracks = await this.lidarr.getTracksForAlbum(albums[0].id);
      if (tracks.length > 0) { tracksLoaded = true; break; }
    }

    if (!tracksLoaded) {
      this.sendMessage(clid, `**${artist.artistName}** agregado, pero los metadatos tardan en cargar. Intenta de nuevo en un momento.`);
      return null;
    }

    this.sendMessage(clid, `**${artist.artistName}** listo.`);
    return added;
  }

  /**
   * Shows the current queue
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleQueue(clid: string): Promise<void> {
    if (this.playQueue.length === 0) {
      this.sendMessage(clid, 'La cola está vacía.');
      return;
    }
    const lines = this.playQueue.map((item: QueueItem, i: number) => `${i + 1}. **${item.track.title}**`);
    this.sendMessage(clid, [`**Cola de reproducción:**`, ...lines].join('\n'));
  }

  /**
   * Handles the next page of the search results
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleMore(clid: string): Promise<void> {
    const pending = this.pendingSearches.get(clid);
    if (!pending) {
      this.sendMessage(clid, '⚠️ Nada pendiente.');
      return;
    }

    const newOffset = pending.offset + PAGE_SIZE;
    if (newOffset >= pending.results.length) {
      this.sendMessage(clid, 'No hay más resultados.');
      return;
    }

    pending.offset = newOffset;
    const page = pending.results.slice(newOffset, newOffset + PAGE_SIZE);
    const hasMore = newOffset + PAGE_SIZE < pending.results.length;
    const footer = hasMore
      ? `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar · **${this.bot.command_prefix}more** para ver más`
      : `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`;
    this.sendMessage(clid, [...page.map(o => o.label), footer].join('\n'));
  }

  /**
   * Handles the pick command
   * @param args String with the arguments for the command.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handlePick(args: string, clid: string): Promise<void> {
    const pending: PendingSearch|undefined = this.pendingSearches.get(clid);

    if (!pending) {
      this.sendMessage(clid, '⚠️ Nada pendiente.');
      return;
    }

    const idx: number = parseInt(args) - 1;
    if (isNaN(idx) || idx < 0 || idx >= pending.results.length) {
      this.sendMessage(clid, `Número inválido. Elige entre **1** y **${pending.results.length}**`);
      return;
    }

    this.pendingSearches.delete(clid);
    const chosen: { label: string, data: LidarrArtist | LidarrTrack | LidarrAlbum } = pending.results[idx];

    switch (pending.type) {

      case 'info_artist': {
        await this.showAlbums(chosen.data as LidarrArtist, clid);
        break;
      }

      case 'new_artist': {
        const added = await this.addArtistAndNotify(chosen.data as LidarrArtist, clid);
        if (added) await this.showAlbums(added, clid);
        break;
      }

      case 'info_album': {
        await this.showTracks(chosen.data as LidarrAlbum, clid);
        break;
      }

      case 'info_tracks': {
        const track = chosen.data as LidarrTrack;
        if (track.hasFile) {
          await this.addToQueue(track, clid);
        } else {
          await this.downloadTrack(track, clid);
        }
        break;
      }
    }
  }

  /**
   * Moves the bot to a specific channel
   * @param channelName String with the name of the channel to move to.
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleMove(channelName: string, clid: string): Promise<void> {
    if (!channelName) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}move <nombre canal>`);
      return;
    }

    await this.moveToChannel(channelName);
    this.sendMessage(clid, `Moviéndome a **${channelName}**`);
  }

  /**
   * Shows the current track
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private handleNowPlaying(clid: string): void {

    if (!this.currentTrack) {
      this.sendMessage(clid, 'Nada reproduciendo.');
      return;
    }

    const name: string|undefined = this.currentTrack.split('/').pop();
    this.sendMessage(clid, `▶ **${name}**`);
  }

  /**
   * Shows the current status of the downloads
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private async handleStatus(clid: string): Promise<void> {
    const queue: LidarrQueueItem[] = await this.lidarr.getQueue();
    if (queue.length === 0) {
      this.sendMessage(clid, '⚠️ No hay nada en la cola de descarga.');
      return;
    }
    const lines: string[] = queue.map((item: LidarrQueueItem, i: number): string => {
      const state: string = item.trackedDownloadState ?? item.status;
      const timeLeft: string = item.timeleft ? ` (${item.timeleft.split('.')[0]})` : '';
      return `${i + 1}. **${item.title.split(' - ').slice(0, 2).join(' - ')}**: ${state}${timeLeft}`;
    });
    this.sendMessage(clid, [`**Cola de descargas:**`, ...lines].join('\n'));
  }

  /**
   * Shows the commands available
   * @param clid String with the client ID of the invoker.
   * @private
   */
  private handleHelp(clid: string): void {
    const p = this.bot.command_prefix;
    this.sendMessage(clid, [
      '**── Comandos disponibles ──**',
      `**${p}play** <artista> →  Buscar artista y reproducir`,
      `**${p}queue**  →  Ver cola actual`,
      `**${p}pick** <n>  →  Elegir de resultados`,
      `**${p}skip**  →  Saltar canción actual`,
      `**${p}stop**  →  Parar y vaciar cola`,
      `**${p}move** <canal>  →  Mover bot a un canal`,
      `**${p}vol** <0-100>  →  Volumen`,
      `**${p}np**  →  Qué suena`,
      // `**${p}info** <artista>  →  Ver álbumes y canciones`,
      `**${p}status**  →  Cola de descargas`,
    ].join('\n'));
  }
}