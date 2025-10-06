import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@googlemaps/google-maps-services-js';
import { z } from 'zod';

// Initialize Google Maps client
const mapsClient = new Client({});

// Tool to calculate travel time with traffic
const getTravelTimeTool = tool(
  'get_travel_time',
  'Calculate travel time between two locations using Google Maps, considering traffic at a specific departure time. Returns duration in traffic.',
  {
    origin: z.string().describe('Starting location (address or place name)'),
    destination: z.string().describe('Destination location (address or place name)'),
    departureTime: z.string().optional().describe('Departure time in ISO format (e.g., 2025-01-15T08:00:00). If not provided, uses current time.'),
    mode: z.enum(['driving', 'walking', 'bicycling', 'transit']).optional().default('driving').describe('Mode of transportation'),
  },
  async (args) => {
    console.log(`[Maps] Calculating travel time from ${args.origin} to ${args.destination}`);

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return {
        content: [{
          type: 'text',
          text: 'GOOGLE_MAPS_API_KEY not configured in environment variables.',
        }],
        isError: true,
      };
    }

    try {
      // Parse departure time or use current time
      let departureTimeSeconds: number;
      if (args.departureTime) {
        departureTimeSeconds = Math.floor(new Date(args.departureTime).getTime() / 1000);
      } else {
        departureTimeSeconds = Math.floor(Date.now() / 1000);
      }

      const response = await mapsClient.directions({
        params: {
          origin: args.origin,
          destination: args.destination,
          mode: args.mode as any,
          departure_time: departureTimeSeconds,
          traffic_model: 'best_guess' as any,
          key: apiKey,
        },
      });

      if (response.data.status !== 'OK') {
        return {
          content: [{
            type: 'text',
            text: `Error from Google Maps API: ${response.data.status}`,
          }],
          isError: true,
        };
      }

      const route = response.data.routes[0];
      if (!route) {
        return {
          content: [{
            type: 'text',
            text: 'No route found between the specified locations.',
          }],
          isError: true,
        };
      }

      const leg = route.legs[0];
      const durationInTraffic = leg.duration_in_traffic || leg.duration;
      const distance = leg.distance;

      const durationMinutes = Math.round(durationInTraffic.value / 60);
      const distanceKm = (distance.value / 1000).toFixed(1);

      return {
        content: [{
          type: 'text',
          text: `From: ${leg.start_address}
To: ${leg.end_address}

Distance: ${distanceKm} km
Duration with traffic: ${durationMinutes} minutes (${durationInTraffic.text})
Mode: ${args.mode}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Maps] Error calculating travel time:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error calculating travel time: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Create MCP server with maps tools
export const mapsServer = createSdkMcpServer({
  name: 'google-maps-tools',
  version: '1.0.0',
  tools: [getTravelTimeTool],
});

console.log('[Maps] MCP server created with tools:', mapsServer);
