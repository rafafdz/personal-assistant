import type { Context } from 'grammy';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import https from 'https';
import { transcribeAudio } from '../utils/speech-to-text';

const unlink = promisify(fs.unlink);

export async function downloadVoiceFile(ctx: Context, fileId: string): Promise<string> {
  console.log(`[${new Date().toISOString()}] Downloading voice file: ${fileId}`);

  // Get file info from Telegram
  const file = await ctx.api.getFile(fileId);
  const filePath = file.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  // Download the file
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const tempDir = '/tmp';
  const localFilePath = path.join(tempDir, `voice_${Date.now()}.ogg`);

  // Download file using https
  await new Promise<void>((resolve, reject) => {
    const fileStream = fs.createWriteStream(localFilePath);
    https.get(fileUrl, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(localFilePath, () => {});
      reject(err);
    });
  });

  console.log(`[${new Date().toISOString()}] Voice file downloaded to: ${localFilePath}`);
  return localFilePath;
}

export async function transcribeVoiceMessage(ctx: Context, fileId: string): Promise<string> {
  const localFilePath = await downloadVoiceFile(ctx, fileId);

  console.log(`[${new Date().toISOString()}] Transcribing audio...`);
  const transcribedText = await transcribeAudio(localFilePath);

  // Clean up the temp file
  await unlink(localFilePath);

  console.log(`[${new Date().toISOString()}] Transcription: "${transcribedText}"`);

  // Send the transcription to the user (using HTML mode for reliability)
  const transcriptionMessage = `🎤 <b>Transcription:</b>\n\n<i>${transcribedText}</i>`;
  try {
    await ctx.reply(transcriptionMessage, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`🎤 Transcription:\n\n${transcribedText}`);
  }

  return transcribedText;
}
