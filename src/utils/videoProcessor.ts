import sharp from 'sharp';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ProcessOptions {
  speed?: number;       // default 1.05
  brightness?: number;  // default 0.03
  saturation?: number;  // default 1.05
}

function getVideoDimensions(videoPath: string): { width: number; height: number } {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${videoPath}"`,
    { timeout: 10000 }
  );
  const { streams } = JSON.parse(out.toString());
  return { width: streams[0].width as number, height: streams[0].height as number };
}

async function generateOverlay(width: number, height: number, outPath: string): Promise<void> {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i]     = Math.floor(Math.random() * 255);
    buffer[i + 1] = Math.floor(Math.random() * 255);
    buffer[i + 2] = Math.floor(Math.random() * 255);
    buffer[i + 3] = 3; // alpha 1% — mắt không thấy, pixel matrix thay đổi
  }
  await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
}

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) console.log('[ffmpeg]', line);
    });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))
    );
  });
}

/**
 * Xử lý video để qua TikTok visual fingerprint:
 * - Overlay transparent noise PNG (pixel matrix alteration)
 * - Speed 1.05x (time & frame shift)
 * - Brightness/Saturation tweak (color grading)
 * - Strip metadata (new MD5 hash)
 * - Re-encode H.265
 */
export async function processVideo(
  inputPath: string,
  outputPath: string,
  opts: ProcessOptions = {}
): Promise<void> {
  const speed      = opts.speed      ?? 1.05;
  const brightness = opts.brightness ?? 0.03;
  const saturation = opts.saturation ?? 1.05;

  const { width, height } = getVideoDimensions(inputPath);
  const overlayPath = path.join(os.tmpdir(), `overlay_${Date.now()}.png`);

  try {
    await generateOverlay(width, height, overlayPath);

    await runFFmpeg([
      '-i', inputPath,
      '-i', overlayPath,
      '-filter_complex', [
        `[0:v][1:v]overlay=0:0[v1]`,
        `[v1]setpts=PTS/${speed},eq=brightness=${brightness}:saturation=${saturation}[vout]`,
      ].join(';'),
      '-map', '[vout]',
      '-map', '0:a',
      '-af', `atempo=${speed}`,
      '-map_metadata', '-1',
      // libx264 veryfast: nhẹ hơn x265 ~5x, đủ để đổi MD5 + hash
      '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
      '-threads', '2', // giới hạn CPU để không spike
      '-c:a', 'aac', '-b:a', '128k',
      '-y', outputPath,
    ]);
  } finally {
    if (fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath);
  }
}
