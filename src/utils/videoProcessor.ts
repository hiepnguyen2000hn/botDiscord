import { spawn, execSync } from 'child_process';
import * as fs from 'fs';

export interface ProcessOptions {
  speed?: number;       // default 1.05
  brightness?: number;  // default 0.03
  saturation?: number;  // default 1.05
}

function hasVideoStream(filePath: string): boolean {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
      { timeout: 8000 }
    ).toString().trim();
    return out === 'video';
  } catch {
    return false;
  }
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
 * - geq filter: thêm noise ngẫu nhiên ±3 mỗi pixel (không cần file overlay)
 * - Speed 1.05x video + audio (frame shift)
 * - Brightness/Saturation tweak (color grading)
 * - Strip metadata → MD5 mới
 * - Re-encode H.264 veryfast
 */
export async function processVideo(
  inputPath: string,
  outputPath: string,
  opts: ProcessOptions = {}
): Promise<void> {
  // File là ảnh hoặc không có video stream → copy thẳng, không process
  if (!hasVideoStream(inputPath)) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const speed      = opts.speed      ?? 1.05;
  const brightness = opts.brightness ?? 0.03;
  const saturation = opts.saturation ?? 1.05;

  // geq add noise ±3 mỗi channel — mắt không thấy (ΔE < 0.1), AI thấy pixel khác
  const noiseFilter = [
    `geq=r='clip(r(X,Y)+random(1)*3-1,0,255)':`,
    `g='clip(g(X,Y)+random(2)*3-1,0,255)':`,
    `b='clip(b(X,Y)+random(3)*3-1,0,255)'`,
  ].join('');

  await runFFmpeg([
    '-i', inputPath,
    '-vf', [
      noiseFilter,
      `setpts=PTS/${speed}`,
      `eq=brightness=${brightness}:saturation=${saturation}`,
    ].join(','),
    '-af', `atempo=${speed}`,
    '-map_metadata', '-1',
    '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
    '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k',
    '-y', outputPath,
  ]);
}
