import axios, { AxiosError } from 'axios';

const PROXY_URL = process.env.PROXY_API_URL ?? 'http://localhost:8317';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_MODEL = 'deepseek-chat';

function proxyHeaders() {
  return {
    Authorization: `Bearer ${process.env.PROXY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function deepseekHeaders() {
  return {
    Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
  source: 'proxy' | 'deepseek';
}

// No HTTP response at all (refused/timeout/DNS failure) means the proxy itself is unreachable,
// as opposed to the proxy responding with an error status for the request.
function isProxyUnreachable(err: unknown): boolean {
  return axios.isAxiosError(err) && !(err as AxiosError).response;
}

export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  maxTokens = 1024
): Promise<ChatCompletionResult> {
  try {
    const res = await axios.post(
      `${PROXY_URL}/v1/chat/completions`,
      { model, messages, max_tokens: maxTokens },
      { headers: proxyHeaders(), timeout: 60000 }
    );
    return {
      content: res.data?.choices?.[0]?.message?.content?.trim() ?? '',
      usage: res.data?.usage,
      model,
      source: 'proxy',
    };
  } catch (err) {
    if (!isProxyUnreachable(err) || !process.env.DEEPSEEK_API_KEY) throw err;

    const res = await axios.post(
      `${DEEPSEEK_URL}/chat/completions`,
      { model: DEEPSEEK_MODEL, messages, max_tokens: maxTokens },
      { headers: deepseekHeaders(), timeout: 60000 }
    );
    return {
      content: res.data?.choices?.[0]?.message?.content?.trim() ?? '',
      usage: res.data?.usage,
      model: DEEPSEEK_MODEL,
      source: 'deepseek',
    };
  }
}
