import type { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Downloads an image from Telegram and saves it to /tmp
 * Returns the local file path
 */
export async function downloadAndSaveImage(ctx: Context, fileId: string): Promise<string> {
  console.log(`[${new Date().toISOString()}] Downloading image file ${fileId}`);

  // Get file info from Telegram
  const file = await ctx.api.getFile(fileId);
  const filePath = file.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  // Download the file
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Generate filename with timestamp
  const timestamp = Date.now();
  const extension = path.extname(filePath) || '.jpg';
  const filename = `telegram_image_${timestamp}${extension}`;
  const localPath = path.join('/tmp', filename);

  // Save to /tmp
  fs.writeFileSync(localPath, buffer);

  console.log(`[${new Date().toISOString()}] Image saved to ${localPath}`);

  return localPath;
}
