import axios from 'axios';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { chatCompletion } from './aiClient';

export const DEFAULT_SCRIPT_MODEL = 'claude-sonnet-4-6';
const MAX_ARTICLE_CHARS = 6000;

export interface ExtractedArticle {
  title: string;
  text: string;
  image: string | null;
}

// Real browser UA/headers, not a self-declared bot, so plain anti-bot UA rules don't trip immediately.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
};

function parseHtmlToArticle(html: string, url: string): ExtractedArticle | null {
  // Silent virtual console: don't let jsdom's internal CSS-parsing warnings spam stderr.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;

  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;

  const parsed = new Readability(doc).parse();
  if (!parsed?.textContent?.trim()) return null;

  return {
    title: parsed.title || doc.title || url,
    text: parsed.textContent.trim().slice(0, MAX_ARTICLE_CHARS),
    image: ogImage,
  };
}

async function fetchDirect(url: string): Promise<ExtractedArticle | null> {
  const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000 });
  return parseHtmlToArticle(res.data, url);
}

// Jina AI Reader: renders the page server-side and returns clean text, no API key required.
async function fetchViaJinaReader(url: string): Promise<ExtractedArticle | null> {
  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;

  const res = await axios.get(`https://r.jina.ai/${url}`, { headers, timeout: 20000 });
  const raw: string = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  const titleMatch = raw.match(/^Title:\s*(.+)$/m);
  const markerIdx = raw.indexOf('Markdown Content:');
  const text = (markerIdx >= 0 ? raw.slice(markerIdx + 'Markdown Content:'.length) : raw).trim();
  if (!text) return null;

  return {
    title: titleMatch?.[1]?.trim() || url,
    text: text.slice(0, MAX_ARTICLE_CHARS),
    image: null,
  };
}

// ScrapingBee: renders JS server-side and returns the full HTML, so it still goes through Readability.
async function fetchViaScrapingBee(url: string): Promise<ExtractedArticle | null> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return null;

  const res = await axios.get('https://app.scrapingbee.com/api/v1/', {
    params: { api_key: apiKey, url, render_js: 'true' },
    timeout: 30000,
  });
  return parseHtmlToArticle(res.data, url);
}

export async function extractArticle(url: string): Promise<ExtractedArticle> {
  const sources = [fetchDirect, fetchViaJinaReader, fetchViaScrapingBee];

  for (const fetchArticle of sources) {
    try {
      const article = await fetchArticle(url);
      if (article) return article;
    } catch {
      // Fall through to the next source.
    }
  }

  throw new Error('Không lấy được nội dung bài viết (trang có thể chặn bot hoặc không phải bài báo).');
}

function buildPrompt(article: ExtractedArticle): { system: string; user: string } {
  const system = [
    'Bạn là biên kịch video ngắn (TikTok/Shorts) tiếng Việt.',
    'Chỉ dùng thông tin có trong bài báo được cung cấp, không bịa thêm sự kiện/số liệu không có trong bài.',
    'Viết theo đúng cấu trúc 3 phần: Hook (1-2 câu gây chú ý ngay từ đầu) → Body (2-4 luận điểm chính, mỗi luận điểm 1 đoạn ngắn) → CTA (1 câu kêu gọi tương tác/theo dõi).',
    'Độ dài toàn bộ kịch bản: 150-170 từ.',
    'Không dùng các cụm sáo rỗng như "trong thế giới ngày nay", "hãy cùng khám phá", "như các bạn đã biết".',
    'Trả lời chỉ gồm kịch bản, không giải thích thêm, không markdown, chia rõ 3 dòng nhãn "HOOK:", "BODY:", "CTA:".',
  ].join('\n');

  const user = `Tiêu đề bài báo: ${article.title}\n\nNội dung bài báo:\n${article.text}`;

  return { system, user };
}

export async function generateScript(article: ExtractedArticle, model = DEFAULT_SCRIPT_MODEL): Promise<string> {
  const { system, user } = buildPrompt(article);

  const result = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model
  );

  return result.content || '*(không có phản hồi)*';
}
