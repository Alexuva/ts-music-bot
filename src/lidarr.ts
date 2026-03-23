import type {LidarrConfig} from './config.js';

export interface LidarrTrack {
  id: number;
  trackFileId: number;
  title: string;
  duration: number;
  hasFile: boolean;
  artistId: number;
  albumId: number;
  trackFile?: {
    id: number;
    path: string;
    quality: {
      quality: {
        name: string;
        bitrate: number;
      };
    };
  };
}

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  status: string;
  disambiguation?: string;
  remotePoster?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
  monitored?: boolean;
  added?: string;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  releaseDate: string;
  artistId: number;
  artist: { artistName: string };
  statistics?: { trackFileCount: number };
}

export interface LidarrQueueItem {
  id: number;
  title: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  timeleft?: string;
  errorMessage?: string;
}

export class LidarrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LidarrError';
  }
}

export class LidarrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVer: string;

  constructor(config: LidarrConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiVer = "/api/v1";
    this.apiKey = config.api_key;
  }

  private async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${this.apiVer}${endpoint}`);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    console.log('[Lidarr] GET', url.toString());

    const res: Response = await fetch(url.toString(), {
      headers: { 'X-Api-Key': this.apiKey }
    });

    if (!res.ok) {
      throw new LidarrError(`API error ${res.status}: ${await res.text()}`);
    }

    return await res.json() as T;
  }

  private async put<T>(endpoint: string, body: unknown): Promise<T> {

    const res: Response = await fetch(`${this.baseUrl}${this.apiVer}${endpoint}`, {
      method: 'PUT',
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new LidarrError(`API error ${res.status}: ${await res.text()}`);
    }

    return await res.json() as T;
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const res: Response = await fetch(`${this.baseUrl}${this.apiVer}${endpoint}`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new LidarrError(`API error ${res.status}: ${await res.text()}`);
    }

    return await res.json() as T;
  }

  async searchTracks(query: string): Promise<LidarrTrack[]> {

    const artists: LidarrArtist[] = await this.get<LidarrArtist[]>('/artist');
    console.log('[Lidarr] searchTracks artists:', artists.length);

    if (artists.length === 0) return [];

    const q: string = query.toLowerCase();
    const results: LidarrTrack[] = [];

    for (const artist of artists) {
      const albums: LidarrAlbum[] = await this.get<LidarrAlbum[]>('/album', { artistId: String(artist.id) });

      for (const album of albums) {
        const tracks: LidarrTrack[] = await this.get<LidarrTrack[]>('/track', { albumId: String(album.id), includeTrackFile: 'true' });
        const matches: LidarrTrack[] = tracks.filter((t: LidarrTrack): boolean => t.title.toLowerCase().includes(q) && t.hasFile);

        if (matches.length > 0) console.log('[Lidarr] Found matches:', matches.map(t => t.title));

        results.push(...matches);
      }

    }

    console.log('[Lidarr] searchTracks results:', results.length);
    return results;
  }

  async getTrackFile(trackFileId: number): Promise<{ path: string }> {
    return this.get<{ path: string }>(`/trackfile/${trackFileId}`);
  }

  async getAllArtists(): Promise<LidarrArtist[]> {
    return this.get<LidarrArtist[]>('/artist');
  }

  async searchLocalArtists(query: string): Promise<LidarrArtist[]> {
    const artists: LidarrArtist[] = await this.get<LidarrArtist[]>('/artist');
    const q: string = query.toLowerCase();

    const byName = artists.filter((a: LidarrArtist) => a.artistName.toLowerCase().includes(q));
    if (byName.length > 0) return byName;

    // Si no hay coincidencia por nombre, buscar en MusicBrainz y cruzar por foreignArtistId
    const lookup: LidarrArtist[] = await this.lookupArtists(query);
    const foreignIds = new Set(lookup.map((a: LidarrArtist) => a.foreignArtistId));
    return artists.filter((a: LidarrArtist) => a.foreignArtistId && foreignIds.has(a.foreignArtistId));
  }

  async lookupArtists(query: string): Promise<LidarrArtist[]> {
    return this.get<LidarrArtist[]>('/artist/lookup', { term: query });
  }

  async getAlbums(artistId: number): Promise<LidarrAlbum[]> {
    return this.get<LidarrAlbum[]>('/album', { artistId: String(artistId) });
  }

  async getDefaultProfiles(): Promise<{ qualityProfileId: number; metadataProfileId: number; rootFolderPath: string }> {
    const [qualityProfiles, metadataProfiles, rootFolders] = await Promise.all([
      this.get<Array<{ id: number }>>('/qualityprofile'),
      this.get<Array<{ id: number }>>('/metadataprofile'),
      this.get<Array<{ path: string }>>('/rootfolder'),
    ]);

    return {
      qualityProfileId: qualityProfiles[0]?.id ?? 1,
      metadataProfileId: metadataProfiles[0]?.id ?? 1,
      rootFolderPath: rootFolders[0]?.path ?? '/music',
    };
  }

  async addArtist(artist: LidarrArtist): Promise<LidarrArtist> {
    const profiles:{ qualityProfileId: number; metadataProfileId: number; rootFolderPath: string } = await this.getDefaultProfiles();

    return this.post<LidarrArtist>('/artist', {
      ...artist,
      rootFolderPath: profiles.rootFolderPath,
      qualityProfileId: profiles.qualityProfileId,
      metadataProfileId: profiles.metadataProfileId,
      monitored: true,
      monitorNewItems: 'none',
      addOptions: {
        monitor: 'future',
        searchForMissingAlbums: false,
      }
    });
  }

  async monitorAlbum(albumId: number): Promise<void> {
    await this.put<void>('/album/monitor', { albumIds: [albumId], monitored: true });
  }

  async searchAlbum(albumId: number): Promise<void> {
    await this.post<void>('/command', { name: 'AlbumSearch', albumIds: [albumId] });
  }

  async getTracksForAlbum(albumId: number): Promise<LidarrTrack[]> {
    return this.get<LidarrTrack[]>('/track', { albumId: String(albumId) });
  }

  async getQueue(): Promise<LidarrQueueItem[]> {
    const result: { records: LidarrQueueItem[] } = await this.get<{ records: LidarrQueueItem[] }>('/queue');
    console.log('[Lidarr] Queue[0]:', JSON.stringify(result.records[0], null, 2));

    return result.records;
  }
}