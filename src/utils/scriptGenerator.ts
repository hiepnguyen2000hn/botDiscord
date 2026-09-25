import axios from 'axios';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

export const DEFAULT_SCRIPT_MODEL = 'claude-sonnet-4-6';
const PROXY_URL = process.env.PROXY_API_URL ?? 'http://localhost:8317';
const MAX_ARTICLE_CHARS = 6000;

function proxyHeaders() {
  return {
    Authorization: `Bearer ${process.env.PROXY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export interface ExtractedArticle {
  title: string;
  text: string;
  image: string | null;
}

export async function extractArticle(url: string): Promise<ExtractedArticle> {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScriptwriterBot/1.0)' },
    timeout: 15000,
  });

  // Silent virtual console: don't let jsdom's internal CSS-parsing warnings spam stderr.
  const dom = new JSDOM(res.data, { url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;

  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;

  const parsed = new Readability(doc).parse();
  if (!parsed?.textContent?.trim()) {
    throw new Error('Không lấy được nội dung bài viết (trang có thể chặn bot hoặc không phải bài báo).');
  }

  return {
    title: parsed.title || doc.title || url,
    text: parsed.textContent.trim().slice(0, MAX_ARTICLE_CHARS),
    image: ogImage,
  };
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

  const res = await axios.post(
    `${PROXY_URL}/v1/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 1024,
    },
    { headers: proxyHeaders(), timeout: 60000 }
  );

  return res.data?.choices?.[0]?.message?.content?.trim() ?? '*(không có phản hồi)*';
}
