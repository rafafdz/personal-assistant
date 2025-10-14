import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { SpotifyApi, AccessToken, SdkConfiguration, MaxInt } from '@spotify/web-api-ts-sdk';
import type { default as IAuthStrategy } from '@spotify/web-api-ts-sdk/dist/mjs/auth/IAuthStrategy.js';
import { z } from 'zod';
import { db } from '../db/client';
import { spotifyTokens, conversations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { env } from '../env';

// Database helper functions
const getSpotifyTokens = async (conversationId: string) => {
  const result = await db
    .select()
    .from(spotifyTokens)
    .where(eq(spotifyTokens.conversationId, conversationId))
    .limit(1);

  return result[0] || null;
};

const saveSpotifyTokens = async (conversationId: string, tokens: AccessToken, scope?: string) => {
  await db.insert(spotifyTokens).values({
    conversationId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : Date.now() + (3600 * 1000),
    scope: scope || null,
    tokenType: tokens.token_type,
  }).onConflictDoUpdate({
    target: spotifyTokens.conversationId,
    set: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : Date.now() + (3600 * 1000),
      scope: scope || null,
      tokenType: tokens.token_type,
      updatedAt: new Date(),
    }
  });
};

// Custom authentication strategy that uses our stored tokens
class StoredTokenAuthenticationStrategy implements IAuthStrategy {
  private conversationId: string;
  private accessToken: AccessToken | null = null;
  private configuration?: SdkConfiguration;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  public setConfiguration(configuration: SdkConfiguration): void {
    this.configuration = configuration;
  }

  public async getOrCreateAccessToken(): Promise<AccessToken> {
    // If we have a cached token that's not expired, return it
    if (this.accessToken && this.accessToken.expires && this.accessToken.expires > Date.now()) {
      return this.accessToken;
    }

    // Otherwise, fetch from database
    const tokenData = await getSpotifyTokens(this.conversationId);
    if (!tokenData) {
      throw new Error('NOT_AUTHENTICATED');
    }

    // Check if token is expired
    const isExpired = tokenData.expiryDate && tokenData.expiryDate < Date.now();

    if (isExpired && tokenData.refreshToken) {
      // Refresh the token
      const newTokens = await this.refreshAccessToken(tokenData.refreshToken);
      await saveSpotifyTokens(this.conversationId, newTokens, tokenData.scope || undefined);
      this.accessToken = newTokens;
      return newTokens;
    }

    // Token is still valid
    this.accessToken = {
      access_token: tokenData.accessToken,
      refresh_token: tokenData.refreshToken,
      token_type: tokenData.tokenType || 'Bearer',
      expires_in: tokenData.expiryDate ? Math.floor((tokenData.expiryDate - Date.now()) / 1000) : 3600,
      expires: tokenData.expiryDate || undefined,
    };

    return this.accessToken;
  }

  public async getAccessToken(): Promise<AccessToken | null> {
    try {
      return await this.getOrCreateAccessToken();
    } catch (error) {
      return null;
    }
  }

  public removeAccessToken(): void {
    this.accessToken = null;
  }

  private async refreshAccessToken(refreshToken: string): Promise<AccessToken> {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh token: ${response.statusText}`);
    }

    const data: any = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken, // Spotify may not return a new refresh token
      token_type: data.token_type,
      expires_in: data.expires_in,
      expires: Date.now() + (data.expires_in * 1000),
    };
  }

  public async removeStoredAuthentication(): Promise<void> {
    await db.delete(spotifyTokens).where(eq(spotifyTokens.conversationId, this.conversationId));
    this.accessToken = null;
  }
}

// Get Spotify client for a conversation
const getSpotifyClient = async (conversationId: string): Promise<SpotifyApi> => {
  const authStrategy = new StoredTokenAuthenticationStrategy(conversationId);
  return new SpotifyApi(authStrategy);
};

// Helper to handle SDK bug where 204 No Content responses are parsed as JSON
// Many Spotify Web API endpoints return 204 with no body, but the SDK tries to parse it
const handleSpotifyError = (error: any, successMessage: string) => {
  if (error.message === 'NOT_AUTHENTICATED') {
    return {
      content: [{
        type: 'text',
        text: `User is not authenticated with Spotify.`,
      }],
      isError: true,
    };
  }

  // SDK bug: Many endpoints return 204 No Content but SDK tries to parse as JSON
  // If we get a JSON parse error, the operation likely succeeded
  if (error instanceof SyntaxError && error.message.includes('JSON')) {
    console.log(`[Spotify] JSON parse error (likely successful operation despite error)`);
    return {
      content: [{
        type: 'text',
        text: successMessage,
      }],
    };
  }

  // Check for Premium requirement
  if (error.message && (error.message.includes('Premium') || error.message.includes('403') || error.message.includes('Restriction violated'))) {
    return {
      content: [{
        type: 'text',
        text: `This feature requires Spotify Premium or an active playback session. Make sure Spotify is open and playing on a device.`,
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Error: ${error.message}`,
    }],
    isError: true,
  };
};

// Generate OAuth URL
export const generateAuthUrl = (conversationId: string) => {
  console.log(`[Spotify] Generating auth URL for conversation ${conversationId}`);

  const scopes = [
    'user-read-playback-state',      // For getting current playback and queue
    'user-modify-playback-state',    // For controlling playback and modifying queue
    'user-read-currently-playing',   // For seeing what's currently playing
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-library-read',
    'user-library-modify',
    'user-top-read',
    'user-read-recently-played',
  ];

  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: scopes.join(' '),
    state: conversationId,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  console.log(`[Spotify] Generated auth URL: ${authUrl}`);
  return authUrl;
};

// Exchange code for tokens
export const handleOAuthCallback = async (code: string, conversationId: string) => {
  console.log(`[Spotify] Handling OAuth callback for conversation ${conversationId}`);

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    const tokens = await response.json() as AccessToken & { scope?: string };
    console.log(`[Spotify] Tokens received:`, {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    // Ensure conversation exists
    await db.insert(conversations).values({
      id: conversationId,
      context: [],
    }).onConflictDoNothing();

    // Save tokens
    await saveSpotifyTokens(conversationId, tokens, tokens.scope);
    console.log(`[Spotify] Stored tokens for conversation ${conversationId}`);

    return { success: true };
  } catch (error: any) {
    console.error(`[Spotify] Error exchanging code for tokens:`, error);
    throw error;
  }
};

// Tool to get authentication URL
const getAuthUrlTool = tool(
  'get_spotify_auth_url',
  'Get Spotify authentication URL for this conversation. Call this when user needs to connect their Spotify account. The URL will be provided in the response for you to send to the user.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Getting auth URL for conversation ${args.conversationId}`);
    try {
      const authUrl = generateAuthUrl(args.conversationId);
      return {
        content: [{
          type: 'text',
          text: `Spotify Authentication URL: ${authUrl}\n\nPlease send this link to the user and ask them to:\n1. Click the link to authorize with Spotify\n2. Copy the authorization code they receive\n3. Send you the code so you can complete the connection using set_spotify_auth_token`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error generating auth URL:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error generating authentication URL: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to set authentication token
const setAuthTokenTool = tool(
  'set_spotify_auth_token',
  'Set Spotify authentication token for this conversation after the user provides the authorization code. Call this after the user has authorized and sent you their code.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    authCode: z.string().describe('Authorization code provided by the user after they authorized'),
  },
  async (args) => {
    console.log(`[Spotify] Setting auth token for conversation ${args.conversationId}`);
    try {
      await handleOAuthCallback(args.authCode, args.conversationId);
      return {
        content: [{
          type: 'text',
          text: `Spotify successfully connected! The user can now control their Spotify playback.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error setting auth token:`, error);
      return {
        content: [{
          type: 'text',
          text: `Failed to connect Spotify: ${error.message}. Please ask the user to try the authentication process again.`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to get current playback
const getCurrentPlaybackTool = tool(
  'get_current_playback',
  'Get information about the user\'s current playback including the currently playing track, playback state, and device.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Getting current playback for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const playback = await spotify.player.getCurrentlyPlayingTrack();

      if (!playback || !playback.item) {
        return {
          content: [{
            type: 'text',
            text: 'Nothing is currently playing on Spotify.',
          }],
        };
      }

      const track = playback.item;
      const artists = 'artists' in track ? track.artists.map((a: any) => a.name).join(', ') : 'Unknown';
      const trackName = track.name;
      const album = 'album' in track ? track.album.name : 'Unknown';
      const isPlaying = playback.is_playing;
      const progress = playback.progress_ms ? Math.floor(playback.progress_ms / 1000) : 0;
      const duration = track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0;

      return {
        content: [{
          type: 'text',
          text: `Currently ${isPlaying ? 'playing' : 'paused'}:\n\n🎵 "${trackName}"\n👤 ${artists}\n💿 ${album}\n⏱️ ${progress}s / ${duration}s`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting playback:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify. Use the get_spotify_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting current playback: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to play/resume playback
const playTool = tool(
  'play_spotify',
  'Resume playback or start playing a specific track, album, artist, or playlist by URI.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    contextUri: z.string().optional().describe('Spotify URI of the context to play (album, artist, or playlist URI)'),
    uris: z.array(z.string()).optional().describe('Array of track URIs to play'),
  },
  async (args) => {
    console.log(`[Spotify] Playing for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);

      // Let Spotify choose the active device
      if (args.contextUri) {
        await spotify.player.startResumePlayback('', args.contextUri);
      } else if (args.uris) {
        await spotify.player.startResumePlayback('', undefined, args.uris);
      } else {
        await spotify.player.startResumePlayback('');
      }

      return {
        content: [{
          type: 'text',
          text: 'Playback started!',
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error starting playback:`, error);
      return handleSpotifyError(error, 'Playback started!');
    }
  }
);

// Tool to pause playback
const pauseTool = tool(
  'pause_spotify',
  'Pause the user\'s Spotify playback.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Pausing for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.pausePlayback('');

      return {
        content: [{
          type: 'text',
          text: 'Playback paused.',
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error pausing:`, error);
      return handleSpotifyError(error, 'Playback paused.');
    }
  }
);

// Tool to skip to next track
const nextTrackTool = tool(
  'next_track',
  'Skip to the next track in the user\'s playback queue.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Skipping to next track for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.skipToNext('');

      return {
        content: [{
          type: 'text',
          text: 'Skipped to next track.',
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error skipping:`, error);
      return handleSpotifyError(error, 'Skipped to next track.');
    }
  }
);

// Tool to skip to previous track
const previousTrackTool = tool(
  'previous_track',
  'Skip to the previous track in the user\'s playback queue.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Skipping to previous track for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.skipToPrevious('');

      return {
        content: [{
          type: 'text',
          text: 'Skipped to previous track.',
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error skipping back:`, error);
      return handleSpotifyError(error, 'Skipped to previous track.');
    }
  }
);

// Tool to search Spotify
const searchTool = tool(
  'search_spotify',
  'Search for tracks, albums, artists, or playlists on Spotify.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    query: z.string().describe('Search query'),
    types: z.array(z.enum(['track', 'album', 'artist', 'playlist'])).describe('Types of items to search for'),
    limit: z.number().optional().default(5).describe('Number of results to return (default 5)'),
  },
  async (args) => {
    console.log(`[Spotify] Searching for "${args.query}" for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      // Spotify SDK limit must be one of the predefined values
      const validLimit = [1, 2, 3, 4, 5, 10, 20, 50].includes(args.limit || 5) ? (args.limit as 1 | 2 | 3 | 4 | 5 | 10 | 20 | 50) : 5;
      const results = await spotify.search(args.query, args.types, undefined, validLimit);

      let responseText = `Search results for "${args.query}":\n\n`;

      if (results.tracks && results.tracks.items.length > 0) {
        responseText += '🎵 Tracks:\n';
        results.tracks.items.forEach((track: any, i: number) => {
          responseText += `${i + 1}. "${track.name}" by ${track.artists.map((a: any) => a.name).join(', ')}\n   URI: ${track.uri}\n`;
        });
        responseText += '\n';
      }

      if (results.albums && results.albums.items.length > 0) {
        responseText += '💿 Albums:\n';
        results.albums.items.forEach((album: any, i: number) => {
          responseText += `${i + 1}. "${album.name}" by ${album.artists.map((a: any) => a.name).join(', ')}\n   URI: ${album.uri}\n`;
        });
        responseText += '\n';
      }

      if (results.artists && results.artists.items.length > 0) {
        responseText += '👤 Artists:\n';
        results.artists.items.forEach((artist: any, i: number) => {
          responseText += `${i + 1}. ${artist.name}\n   URI: ${artist.uri}\n`;
        });
        responseText += '\n';
      }

      if (results.playlists && results.playlists.items.length > 0) {
        responseText += '📝 Playlists:\n';
        results.playlists.items.forEach((playlist: any, i: number) => {
          responseText += `${i + 1}. "${playlist.name}" by ${playlist.owner.display_name}\n   URI: ${playlist.uri}\n`;
        });
      }

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error searching:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error searching Spotify: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to set volume
const setVolumeTool = tool(
  'set_volume',
  'Set the volume for the user\'s Spotify playback (0-100).',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    volumePercent: z.number().min(0).max(100).describe('Volume level from 0 to 100'),
  },
  async (args) => {
    console.log(`[Spotify] Setting volume to ${args.volumePercent}% for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.setPlaybackVolume(args.volumePercent);

      return {
        content: [{
          type: 'text',
          text: `Volume set to ${args.volumePercent}%.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error setting volume:`, error);
      return handleSpotifyError(error, `Volume set to ${args.volumePercent}%.`);
    }
  }
);

// Tool to get the queue
const getQueueTool = tool(
  'get_queue',
  'Get the user\'s current Spotify playback queue, showing what\'s currently playing and what\'s coming up next.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Getting queue for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const queue = await spotify.player.getUsersQueue();

      if (!queue.currently_playing && queue.queue.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'The queue is empty. Nothing is currently playing.',
          }],
        };
      }

      let responseText = 'Current Queue:\n\n';

      // Currently playing
      if (queue.currently_playing) {
        const current = queue.currently_playing;
        const artists = 'artists' in current ? current.artists.map((a: any) => a.name).join(', ') : 'Unknown';
        responseText += `🎵 Now Playing:\n"${current.name}" by ${artists}\n\n`;
      }

      // Queue
      if (queue.queue.length > 0) {
        responseText += '📋 Up Next:\n';
        queue.queue.slice(0, 10).forEach((item: any, i: number) => {
          const artists = 'artists' in item ? item.artists.map((a: any) => a.name).join(', ') : 'Unknown';
          responseText += `${i + 1}. "${item.name}" by ${artists}\n`;
        });

        if (queue.queue.length > 10) {
          responseText += `\n... and ${queue.queue.length - 10} more tracks`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting queue:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting queue: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to add track to queue
const addToQueueTool = tool(
  'add_to_queue',
  'Add a track or episode to the end of the user\'s Spotify playback queue. The track will play after all currently queued tracks. Requires Spotify Premium.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    uri: z.string().describe('Spotify URI of the track or episode to add (e.g., "spotify:track:4iV5W9uYEdYUVa79Axb7Rh"). Get URIs from search results.'),
  },
  async (args) => {
    console.log(`[Spotify] Adding to queue: ${args.uri} for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.addItemToPlaybackQueue(args.uri);

      return {
        content: [{
          type: 'text',
          text: 'Track added to queue!',
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error adding to queue:`, error);
      return handleSpotifyError(error, 'Track added to queue!');
    }
  }
);

// Tool to get user's playlists
const getUserPlaylistsTool = tool(
  'get_user_playlists',
  'Get a list of the current user\'s Spotify playlists.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    limit: z.number().optional().default(20).describe('Number of playlists to return (max 50)'),
  },
  async (args) => {
    console.log(`[Spotify] Getting user playlists for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const currentUser = await spotify.currentUser.profile();
      const playlists = await spotify.playlists.getUsersPlaylists(currentUser.id, args.limit as MaxInt<50>);

      if (playlists.items.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No playlists found.',
          }],
        };
      }

      let responseText = `Your Playlists (${playlists.total} total):\n\n`;
      playlists.items.forEach((playlist: any, i: number) => {
        responseText += `${i + 1}. "${playlist.name}"\n`;
        responseText += `   Tracks: ${playlist.tracks.total}\n`;
        responseText += `   ID: ${playlist.id}\n`;
        responseText += `   URI: ${playlist.uri}\n\n`;
      });

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting playlists:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting playlists: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to get playlist tracks
const getPlaylistTracksTool = tool(
  'get_playlist_tracks',
  'Get the tracks in a specific Spotify playlist.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    playlistId: z.string().describe('Playlist ID'),
    limit: z.number().optional().default(20).describe('Number of tracks to return (max 50)'),
  },
  async (args) => {
    console.log(`[Spotify] Getting playlist tracks for ${args.playlistId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const tracks = await spotify.playlists.getPlaylistItems(args.playlistId, undefined, undefined, args.limit as MaxInt<50>);

      if (tracks.items.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'This playlist is empty.',
          }],
        };
      }

      let responseText = `Playlist Tracks (${tracks.total} total):\n\n`;
      tracks.items.forEach((item: any, i: number) => {
        if (item.track) {
          const track = item.track;
          const artists = track.artists ? track.artists.map((a: any) => a.name).join(', ') : 'Unknown';
          responseText += `${i + 1}. "${track.name}" by ${artists}\n`;
          responseText += `   URI: ${track.uri}\n`;
        }
      });

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting playlist tracks:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting playlist tracks: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to create playlist
const createPlaylistTool = tool(
  'create_playlist',
  'Create a new Spotify playlist for the user.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    name: z.string().describe('Playlist name'),
    description: z.string().optional().describe('Playlist description'),
    isPublic: z.boolean().optional().default(true).describe('Whether the playlist is public'),
  },
  async (args) => {
    console.log(`[Spotify] Creating playlist "${args.name}" for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const currentUser = await spotify.currentUser.profile();
      const playlist = await spotify.playlists.createPlaylist(currentUser.id, {
        name: args.name,
        description: args.description,
        public: args.isPublic,
      });

      return {
        content: [{
          type: 'text',
          text: `Playlist "${playlist.name}" created successfully!\n\nID: ${playlist.id}\nURI: ${playlist.uri}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error creating playlist:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error creating playlist: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to add tracks to playlist
const addTracksToPlaylistTool = tool(
  'add_tracks_to_playlist',
  'Add tracks to a Spotify playlist.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    playlistId: z.string().describe('Playlist ID'),
    trackUris: z.array(z.string()).describe('Array of track URIs to add'),
    position: z.number().optional().describe('Position to insert tracks (0-based index)'),
  },
  async (args) => {
    console.log(`[Spotify] Adding ${args.trackUris.length} tracks to playlist ${args.playlistId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.playlists.addItemsToPlaylist(args.playlistId, args.trackUris, args.position);

      return {
        content: [{
          type: 'text',
          text: `Successfully added ${args.trackUris.length} track(s) to the playlist!`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error adding tracks to playlist:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error adding tracks to playlist: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to remove tracks from playlist
const removeTracksFromPlaylistTool = tool(
  'remove_tracks_from_playlist',
  'Remove tracks from a Spotify playlist.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    playlistId: z.string().describe('Playlist ID'),
    trackUris: z.array(z.string()).describe('Array of track URIs to remove'),
  },
  async (args) => {
    console.log(`[Spotify] Removing ${args.trackUris.length} tracks from playlist ${args.playlistId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.playlists.removeItemsFromPlaylist(args.playlistId, {
        tracks: args.trackUris.map(uri => ({ uri })),
      });

      return {
        content: [{
          type: 'text',
          text: `Successfully removed ${args.trackUris.length} track(s) from the playlist!`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error removing tracks from playlist:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error removing tracks from playlist: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to modify playlist details
const modifyPlaylistTool = tool(
  'modify_playlist',
  'Modify the details of a Spotify playlist (name, description, public status).',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    playlistId: z.string().describe('Playlist ID'),
    name: z.string().optional().describe('New playlist name'),
    description: z.string().optional().describe('New playlist description'),
    isPublic: z.boolean().optional().describe('Whether the playlist should be public'),
  },
  async (args) => {
    console.log(`[Spotify] Modifying playlist ${args.playlistId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const updates: any = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.isPublic !== undefined) updates.public = args.isPublic;

      await spotify.playlists.changePlaylistDetails(args.playlistId, updates);

      return {
        content: [{
          type: 'text',
          text: `Playlist details updated successfully!`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error modifying playlist:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error modifying playlist: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to get track/album/artist info
const getItemInfoTool = tool(
  'get_item_info',
  'Get detailed information about a Spotify track, album, or artist by URI.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    uri: z.string().describe('Spotify URI (track, album, or artist)'),
  },
  async (args) => {
    console.log(`[Spotify] Getting info for ${args.uri}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const [type, id] = args.uri.replace('spotify:', '').split(':');

      let responseText = '';

      if (type === 'track') {
        const track = await spotify.tracks.get(id);
        const artists = track.artists.map(a => a.name).join(', ');
        responseText = `Track Information:\n\n`;
        responseText += `🎵 "${track.name}"\n`;
        responseText += `👤 ${artists}\n`;
        responseText += `💿 ${track.album.name}\n`;
        responseText += `⏱️ Duration: ${Math.floor(track.duration_ms / 1000)}s\n`;
        responseText += `⭐ Popularity: ${track.popularity}/100\n`;
        responseText += `URI: ${track.uri}`;
      } else if (type === 'album') {
        const album = await spotify.albums.get(id);
        const artists = album.artists.map(a => a.name).join(', ');
        responseText = `Album Information:\n\n`;
        responseText += `💿 "${album.name}"\n`;
        responseText += `👤 ${artists}\n`;
        responseText += `📅 Release: ${album.release_date}\n`;
        responseText += `🎵 Tracks: ${album.total_tracks}\n`;
        responseText += `⭐ Popularity: ${album.popularity}/100\n`;
        responseText += `URI: ${album.uri}`;
      } else if (type === 'artist') {
        const artist = await spotify.artists.get(id);
        responseText = `Artist Information:\n\n`;
        responseText += `👤 ${artist.name}\n`;
        responseText += `🎸 Genres: ${artist.genres.join(', ') || 'N/A'}\n`;
        responseText += `👥 Followers: ${artist.followers.total.toLocaleString()}\n`;
        responseText += `⭐ Popularity: ${artist.popularity}/100\n`;
        responseText += `URI: ${artist.uri}`;
      } else {
        return {
          content: [{
            type: 'text',
            text: `Unsupported URI type: ${type}. Supported types are: track, album, artist.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting item info:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting item info: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to get recommendations
const getRecommendationsTool = tool(
  'get_recommendations',
  'Get track recommendations based on seed artists, tracks, or genres.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    seedArtists: z.array(z.string()).optional().describe('Array of artist IDs to seed recommendations'),
    seedTracks: z.array(z.string()).optional().describe('Array of track IDs to seed recommendations'),
    seedGenres: z.array(z.string()).optional().describe('Array of genres to seed recommendations'),
    limit: z.number().optional().default(10).describe('Number of recommendations to return (max 20)'),
  },
  async (args) => {
    console.log(`[Spotify] Getting recommendations for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);

      const recommendations = await spotify.recommendations.get({
        seed_artists: args.seedArtists,
        seed_tracks: args.seedTracks,
        seed_genres: args.seedGenres,
        limit: args.limit,
      });

      if (recommendations.tracks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No recommendations found.',
          }],
        };
      }

      let responseText = `Recommended Tracks:\n\n`;
      recommendations.tracks.forEach((track: any, i: number) => {
        const artists = track.artists.map((a: any) => a.name).join(', ');
        responseText += `${i + 1}. "${track.name}" by ${artists}\n`;
        responseText += `   URI: ${track.uri}\n`;
      });

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting recommendations:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting recommendations: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to seek to position
const seekToPositionTool = tool(
  'seek_to_position',
  'Seek to a specific position in the currently playing track.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    positionMs: z.number().describe('Position in milliseconds to seek to'),
  },
  async (args) => {
    console.log(`[Spotify] Seeking to position ${args.positionMs}ms for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.seekToPosition(args.positionMs);

      return {
        content: [{
          type: 'text',
          text: `Seeked to ${Math.floor(args.positionMs / 1000)}s.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error seeking:`, error);
      return handleSpotifyError(error, `Seeked to ${Math.floor(args.positionMs / 1000)}s.`);
    }
  }
);

// Tool to set repeat mode
const setRepeatModeTool = tool(
  'set_repeat_mode',
  'Set the repeat mode for playback.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    state: z.enum(['track', 'context', 'off']).describe('Repeat mode: "track" (repeat current track), "context" (repeat playlist/album), or "off"'),
  },
  async (args) => {
    console.log(`[Spotify] Setting repeat mode to ${args.state} for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.setRepeatMode(args.state);

      return {
        content: [{
          type: 'text',
          text: `Repeat mode set to "${args.state}".`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error setting repeat mode:`, error);
      return handleSpotifyError(error, `Repeat mode set to "${args.state}".`);
    }
  }
);

// Tool to toggle shuffle
const toggleShuffleTool = tool(
  'toggle_shuffle',
  'Turn shuffle mode on or off for playback.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    state: z.boolean().describe('true to enable shuffle, false to disable'),
  },
  async (args) => {
    console.log(`[Spotify] Setting shuffle to ${args.state} for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      await spotify.player.togglePlaybackShuffle(args.state);

      return {
        content: [{
          type: 'text',
          text: `Shuffle ${args.state ? 'enabled' : 'disabled'}.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error toggling shuffle:`, error);
      return handleSpotifyError(error, `Shuffle ${args.state ? 'enabled' : 'disabled'}.`);
    }
  }
);

// Tool to get available devices
const getDevicesTool = tool(
  'get_devices',
  'Get a list of the user\'s available Spotify devices.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Spotify] Getting devices for conversation ${args.conversationId}`);
    try {
      const spotify = await getSpotifyClient(args.conversationId);
      const devices = await spotify.player.getAvailableDevices();

      if (devices.devices.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No devices found. Make sure Spotify is open on at least one device.',
          }],
        };
      }

      let responseText = 'Available Devices:\n\n';
      devices.devices.forEach((device: any, i: number) => {
        const active = device.is_active ? ' ✓ ACTIVE' : '';
        responseText += `${i + 1}. ${device.name}${active}\n`;
        responseText += `   Type: ${device.type}\n`;
        responseText += `   Volume: ${device.volume_percent}%\n`;
        responseText += `   ID: ${device.id}\n\n`;
      });

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Spotify] Error getting devices:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Spotify.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error getting devices: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Create MCP server with Spotify tools
export const spotifyServer = createSdkMcpServer({
  name: 'spotify-tools',
  version: '1.0.0',
  tools: [
    // Authentication
    getAuthUrlTool,
    setAuthTokenTool,

    // Playback Control
    getCurrentPlaybackTool,
    playTool,
    pauseTool,
    nextTrackTool,
    previousTrackTool,
    seekToPositionTool,
    setVolumeTool,
    setRepeatModeTool,
    toggleShuffleTool,

    // Queue Management
    getQueueTool,
    addToQueueTool,

    // Search & Discovery
    searchTool,
    getItemInfoTool,
    getRecommendationsTool,

    // Playlist Management
    getUserPlaylistsTool,
    getPlaylistTracksTool,
    createPlaylistTool,
    addTracksToPlaylistTool,
    removeTracksFromPlaylistTool,
    modifyPlaylistTool,

    // Device Management
    getDevicesTool,
  ],
});

console.log('[Spotify] MCP server created with tools');
