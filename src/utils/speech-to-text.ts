import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

/**
 * Transcribe audio file to text using ElevenLabs Speech-to-Text API
 * @param audioFilePath - Path to the audio file
 * @returns Transcribed text
 */
export async function transcribeAudio(audioFilePath: string): Promise<string> {
  try {
    console.log(`[${new Date().toISOString()}] Transcribing audio file: ${audioFilePath}`);

    // Read the audio file
    const audioBuffer = fs.readFileSync(audioFilePath);

    // Create a Blob object from the buffer (SDK expects Blob, not File)
    const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });

    // Call ElevenLabs STT API
    const response = await elevenlabs.speechToText.convert({
      file: audioBlob,
      modelId: 'scribe_v1',
    });

    console.log(`[${new Date().toISOString()}] Transcription complete`);

    // Return the transcribed text
    // Handle both single channel and multichannel responses
    if ('text' in response) {
      return response.text;
    } else if ('transcripts' in response && response.transcripts.length > 0) {
      return response.transcripts[0].text;
    }

    throw new Error('Unexpected response format from ElevenLabs API');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error transcribing audio:`, error);
    throw new Error(`Failed to transcribe audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
