import { Ts3Client } from './tslib/client.js';
import {generateIdentity, IdentityData} from './tslib/identity.js';
import { AudioPipeline, FRAME_MS } from './audio/pipeline.js';
import type { BotConfig, TeamspeakConfig } from './config.js';
import type { LidarrClient, LidarrArtist, LidarrAlbum, LidarrTrack, LidarrQueueItem } from './lidarr.js';
import { Server } from "./webhook.js";

type PendingType = 'artist' | 'track' | 'play' | 'queue';

interface PendingSearch {
  type: PendingType;
  results: Array<{ label: string; data: LidarrArtist | TrackResult | LidarrTrack }>;
}

interface TrackResult {
  album: LidarrAlbum;
  track: LidarrTrack;
  artistName: string;
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
  }

  private async handleCommand(command: string, args: string, clid: string): Promise<void> {
    switch (command) {
      case 'move':          await this.handleMove(args, clid); break;
      case 'play':          await this.handlePlay(args, clid); break;
      case 'search':        await this.handleSearch(args, clid); break;
      case 'pick':          await this.handlePick(args, clid); break;
      case 'queue':         await this.handleQueue(args, clid); break;
      case 'download':      await this.handleDownload(args, clid); break;
      case 'skip':          await this.handleSkip(clid); break;
      case 'stop':          this.handleStop(); break;

      case 'vol':
      case 'volume':        this.handleVolume(args, clid); break;

      case 'np':
      case 'nowplaying':    this.handleNowPlaying(clid); break;

      case 'status':        await this.handleStatus(clid); break;
      case 'help':          this.handleHelp(clid); break;
    }
  }

  private async handlePlay(query: string, clid: string): Promise<void> {
    if (!query) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}play <artista> - <cancion>`);
      return;
    }

    const parts: string[] = query.split(' - ');
    if (parts.length < 2) {
      this.sendMessage(clid, `Formato incorrecto. Usa: ${this.bot.command_prefix}play <artista> - <cancion>`);
      return;
    }

    const artistQuery: string = parts[0].trim();
    const trackQuery: string = parts.slice(1).join(' - ').trim();

    this.sendMessage(clid, `**Buscando:** ${artistQuery} - ${trackQuery}...`);

    const tracks: LidarrTrack[] = await this.lidarr.searchTracks(trackQuery);
    const localTracks: LidarrTrack[] = tracks.filter(t => t.hasFile);

    if (localTracks.length === 0) {
      this.sendMessage(clid, `⚠️ **${artistQuery} - ${trackQuery}** no está en la biblioteca.\nUsa **${this.bot.command_prefix}search ${artistQuery}** para agregarlo.`);
      return;
    }

    if (localTracks.length === 1) {
      await this.addToQueue(localTracks[0], clid);
      return;
    }

    const options: { label: string, data:LidarrTrack }[] = localTracks.slice(0, 5).map((t: LidarrTrack, i: number): { label: string, data: LidarrTrack } => ({
      label: `${i + 1}. ${t.title}`,
      data: t as LidarrTrack
    }));

    this.pendingSearches.set(clid, { type: 'play', results: options });
    this.sendMessage(clid, [`**Varias canciones encontradas:**`, ...options.map((o: { label: string, data: LidarrTrack }): string => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
  }

  private async handleSearch(query: string, clid: string): Promise<void> {
    if (!query) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}search <artista>`);
      return;
    }

    const localArtists: LidarrArtist[] = await this.lidarr.searchLocalArtists(query);
    if (localArtists.length > 0) {
      this.sendMessage(clid, `**${localArtists[0].artistName}** ya está en la biblioteca.\nUsa **${this.bot.command_prefix}download ${localArtists[0].artistName} - <cancion>** para descargar.`);
      return;
    }

    this.sendMessage(clid, `**Buscando:** ${query} en MusicBrainz...`);
    const results: LidarrArtist[] = await this.lidarr.lookupArtists(query);

    if (results.length === 0) {
      this.sendMessage(clid, `⚠️ No se encontró ningún artista con ese nombre.`);
      return;
    }

    if (results.length === 1) {
      await this.addArtistAndNotify(results[0], clid);
      return;
    }

    const options: {label: string, data: LidarrArtist }[] = results.slice(0, 5).map((artist: LidarrArtist, i: number): { label: string, data: LidarrArtist } => ({
      label: `${i + 1}. ${artist.artistName}${artist.disambiguation ? ` (${artist.disambiguation})` : ''}${artist.status ? ` [${artist.status}]` : ''}`,
      data: artist as LidarrArtist
    }));

    this.pendingSearches.set(clid, { type: 'artist', results: options });
    this.sendMessage(clid, [`**Varios resultados:**`, ...options.map((o: {label: string, data: LidarrArtist}): string => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
  }

  private async handlePick(args: string, clid: string): Promise<void> {
    const pending: PendingSearch|undefined = this.pendingSearches.get(clid);

    if (!pending) {
      this.sendMessage(clid, '⚠️ No hay búsqueda pendiente.');
      return;
    }

    const idx: number = parseInt(args) - 1;
    if (isNaN(idx) || idx < 0 || idx >= pending.results.length) {
      this.sendMessage(clid, `Número inválido. Elige entre **1** y **${pending.results.length}**`);
      return;
    }

    this.pendingSearches.delete(clid);
    const chosen: { label: string, data: LidarrArtist | TrackResult | LidarrTrack } = pending.results[idx];

    if (pending.type === 'artist') {
      await this.addArtistAndNotify(chosen.data as LidarrArtist, clid);
    } else if (pending.type === 'track') {
      await this.downloadTrack(chosen.data as TrackResult, clid);
    } else if (pending.type === 'play') {
      await this.playTrack(chosen.data as unknown as LidarrTrack, clid);
    } else if (pending.type === 'queue') {
      await this.addToQueue(chosen.data as unknown as LidarrTrack, clid);
    }
  }

  // !queue — mostrar cola o añadir canción descargada a la cola
  private async handleQueue(query: string, clid: string): Promise<void> {
    if (!query) {

      if (this.playQueue.length === 0) {
        this.sendMessage(clid, 'La cola está vacía.');
        return;
      }

      const lines: string[] = this.playQueue.map((item: QueueItem, i: number): string => `${i + 1}. **${item.track.title}**`);
      this.sendMessage(clid, [`**Cola de reproducción:**`, ...lines].join('\n'));
      return;
    }

    const parts: string[] = query.split(' - ');
    if (parts.length < 2) {
      this.sendMessage(clid, `Formato incorrecto. Usa: ${this.bot.command_prefix}queue <artista> - <canción>`);
      return;
    }

    const trackQuery: string = parts.slice(1).join(' - ').trim();
    const tracks: LidarrTrack[] = await this.lidarr.searchTracks(trackQuery);
    const localTracks: LidarrTrack[] = tracks.filter((t: LidarrTrack): boolean => t.hasFile);

    if (localTracks.length === 0) {
      this.sendMessage(clid, `⚠️ **${trackQuery}** no está descargada. Usa **${this.bot.command_prefix}download** primero.`);
      return;
    }

    if (localTracks.length === 1) {
      await this.addToQueue(localTracks[0], clid);
      return;
    }

    const options: { label: string, data: LidarrTrack }[] = localTracks.slice(0, 5).map((t: LidarrTrack, i: number): { label: string, data: LidarrTrack } => ({
      label: `${i + 1}. ${t.title}`,
      data: t as LidarrTrack
    }));

    this.pendingSearches.set(clid, { type: 'queue', results: options });
    this.sendMessage(clid, [`**Varias canciones encontradas:**`, ...options.map((o: { label: string, data: LidarrTrack }): string => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
  }

  // !download — busca y descarga una canción via Lidarr/Soularr
  private async handleDownload(query: string, clid: string): Promise<void> {
    if (!query) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}download <artista> - <canción>`);
      return;
    }

    const parts: string[] = query.split(' - ');
    if (parts.length < 2) {
      this.sendMessage(clid, `Formato incorrecto. Usa: ${this.bot.command_prefix}download <artista> - <canción>`);
      return;
    }

    const artistQuery: string = parts[0].trim();
    const trackQuery: string = parts.slice(1).join(' - ').trim();
    const q: string = trackQuery.toLowerCase();

    const localArtists: LidarrArtist[] = await this.lidarr.searchLocalArtists(artistQuery);
    if (localArtists.length === 0) {
      this.sendMessage(clid, `⚠️ **${artistQuery}** no está en la biblioteca. Usa **${this.bot.command_prefix}search "${artistQuery}"** primero.`);
      return;
    }

    const artistId: number = localArtists[0].id!;
    const albums: LidarrAlbum[] = await this.lidarr.getAlbums(artistId);

    this.sendMessage(clid, `**Buscando:** ${trackQuery} en la discografía de ${localArtists[0].artistName}...`);

    const matches: TrackResult[] = [];

    for (const album of albums) {
      const tracks: LidarrTrack[] = await this.lidarr.getTracksForAlbum(album.id);
      if (tracks.length === 0) continue;
      const found: LidarrTrack[] = tracks.filter((t: LidarrTrack): boolean => t.title.toLowerCase().includes(q));
      for (const track of found) {
        matches.push({ album, track, artistName: localArtists[0].artistName });
      }
    }

    if (matches.length === 0) {
      this.sendMessage(clid, `⚠️ No se encontró **${trackQuery}** en la discografía de **${localArtists[0].artistName}**.`);
      return;
    }

    if (matches.length === 1) {
      await this.downloadTrack(matches[0], clid);
      return;
    }

    const options: { label: string, data: TrackResult }[] = matches.slice(0, 5).map((m: TrackResult, i: number): { label: string, data: TrackResult } => ({
      label: `${i + 1}. ${m.track.title} (${m.album.title})`,
      data: m as TrackResult
    }));

    this.pendingSearches.set(clid, { type: 'track', results: options });
    this.sendMessage(clid, [`**Varias canciones encontradas:**`, ...options.map((o: {label: string, data: TrackResult}): string => o.label), `Usa **${this.bot.command_prefix}pick <numero>** para seleccionar`].join('\n'));
  }

  private async downloadTrack(result: TrackResult, clid: string): Promise<void> {
    await this.lidarr.monitorAlbum(result.album.id);
    await this.lidarr.searchAlbum(result.album.id);
    this.sendMessage(clid, `**${result.track.title}** (${result.album.title}) en cola para descarga.\nTe aviso cuando esté listo.`);
    if (this.webhook) this.webhook.addPetition(result.album.id, clid);
  }

  private async addToQueue(track: LidarrTrack, clid: string): Promise<void> {
    const trackFile: { path: string } = await this.lidarr.getTrackFile(track.trackFileId);
    this.playQueue.push({ track, trackFilePath: trackFile.path });
    this.sendMessage(clid, `**+** **${track.title}** añadido a la cola (posición ${this.playQueue.length})`);

    if (!this.isPlaying) {
      await this.moveToUserChannel(clid);
      await this.runQueue(clid);
    }
  }

  private async runQueue(clid: string): Promise<void> {
    this.isPlaying = true;

    while (this.playQueue.length > 0) {
      const item: QueueItem = this.playQueue[0];
      this.currentTrack = item.trackFilePath;
      this.sendMessage(clid, `▶ **${item.track.title}**`);
      await this.playFile(item.trackFilePath);
      this.playQueue.shift();
    }

    this.isPlaying = false;
    this.currentTrack = null;
    this.sendMessage(clid, 'Cola terminada.');
  }

  private async handleSkip(clid: string): Promise<void> {
    if (!this.isPlaying) {
      this.sendMessage(clid, '⚠️ No hay nada reproduciendo.');
      return;
    }
    const current: string|undefined = this.currentTrack?.split('/').pop();
    this.sendMessage(clid, `⏭ Saltando **${current}**`);
    this.playing = false;
  }

  private async addArtistAndNotify(artist: LidarrArtist, clid: string): Promise<void> {
    this.sendMessage(clid, `Añadiendo **${artist.artistName}**... esto puede tardar unos segundos.`);

    const added: LidarrArtist = await this.lidarr.addArtist(artist);
    const artistId: number|undefined = added.id;

    if (!artistId) {
      this.sendMessage(clid, `Error al agregar **${artist.artistName}**.`);
      return;
    }

    let albums: LidarrAlbum[] = [];
    let tracksLoaded: boolean = false;

    for (let i: number = 0; i < 20; i++) {
      await new Promise((r: (value: unknown) => void) => setTimeout(r, 3000));
      albums = await this.lidarr.getAlbums(artistId);
      if (albums.length === 0) continue;

      const tracks: LidarrTrack[] = await this.lidarr.getTracksForAlbum(albums[0].id);
      if (tracks.length > 0) {
        tracksLoaded = true;
        break;
      }
    }

    if (!tracksLoaded) {
      this.sendMessage(clid, `**${artist.artistName}** agregado, pero los metadatos tardan en cargar. Intenta **${this.bot.command_prefix}download** en un momento.`);
      return;
    }

    this.sendMessage(clid, `**${artist.artistName}** listo. Usa **${this.bot.command_prefix}download ${artist.artistName} - <cancion>** para descargar.`);
  }

  private handleStop(): void {
    this.playing = false;
    this.isPlaying = false;
    this.playQueue = [];
    this.currentTrack = null;
    this.client.sendVoiceStop();
  }

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

  private handleNowPlaying(clid: string): void {

    if (!this.currentTrack) {
      this.sendMessage(clid, 'Nada reproduciendo.');
      return;
    }

    const name: string|undefined = this.currentTrack.split('/').pop();
    this.sendMessage(clid, `▶ **${name}**`);
  }

  private handleHelp(clid: string): void {
    const p = this.bot.command_prefix;
    this.sendMessage(clid, [
      '**── Comandos disponibles ──**',
      `**${p}play** <artista> - <cancion>  →  Reproducir`,
      `**${p}search** <artista>  →  Agregar artista a la biblioteca`,
      `**${p}download** <artista> - <cancion>  →  Descargar canción`,
      `**${p}queue** <artista> - <cancion>  →  Añadir a la cola`,
      `**${p}queue**  →  Ver cola actual`,
      `**${p}pick** <n>  →  Elegir de resultados`,
      `**${p}skip**  →  Saltar canción actual`,
      `**${p}stop**  →  Parar y vaciar cola`,
      `**${p}move** <canal>  →  Mover bot a un canal`,
      `**${p}vol** <0-100>  →  Volumen`,
      `**${p}np**  →  Qué suena`,
      `**${p}status**  →  Cola de descargas`,
    ].join('\n'));
  }

  private async handleMove(channelName: string, clid: string): Promise<void> {
    if (!channelName) {
      this.sendMessage(clid, `Uso: ${this.bot.command_prefix}move <nombre canal>`);
      return;
    }

    await this.moveToChannel(channelName);
    this.sendMessage(clid, `Moviéndome a **${channelName}**`);
  }

  private async playTrack(track: LidarrTrack, clid: string): Promise<void> {
    const trackFile: { path: string } = await this.lidarr.getTrackFile(track.trackFileId);
    console.log('[Bot] Playing file:', trackFile.path);
    await this.moveToUserChannel(clid);
    this.sendMessage(clid, `Reproduciendo: "${track.title}"`);
    await this.playFile(trackFile.path);
  }

  private async playFile(filePath: string): Promise<void> {
    this.playing = true;
    this.currentTrack = filePath;

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

    this.playing = false;
    this.currentTrack = null;
  }

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

  public sendMessage(clid: string, message: string): void {
    const escaped: string = message
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\p')
      .replace(/\n/g, '\\n')
      .replace(/ /g, '\\s');
    const cmd = `sendtextmessage targetmode=1 target=${clid} msg=${escaped}`;
    this.client.sendCommand(cmd);
  }

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
}