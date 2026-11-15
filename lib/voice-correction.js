// Semantic correction for a spoken utterance.
//
// The recognizer returns words, not intent: homophones, broken clauses, repeated
// particles. One short pass through the non-reasoning Flash route rewrites the sentence
// into something the Agent can act on. It is a *repair* step, never a rewrite step:
// anything that looks like a different request is rejected and the raw transcript is
// used instead, because silently changing what the user meant is worse than a rough
// transcript.

export const CORRECTION_SYSTEM = [
  '你是语音输入的校对器。用户说的是中文口语，转写结果可能有同音错字、断句错误、重复词和口头语。',
  '把这句话改写成一句通顺、可以直接执行的请求：只修正听错和口误，保留原本的意图、称呼、文件名、数字与时间；不要新增信息，不要回答问题，不要解释，不要换一种说法。',
  '只输出改写后的那一句话本身，不要引号、不要前缀、不要换行。',
].join('\n');

const FENCE = /^```[a-z]*\s*([\s\S]*?)\s*```$/iu;
const QUOTES = /^["'“”「」『』\s]+|["'“”「」『』\s]+$/gu;

/** A candidate is only usable when it still looks like the same request. */
export function sanitizeCorrection(raw, candidate) {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (typeof candidate !== 'string' || !source) return source;
  const fenced = FENCE.exec(candidate.trim());
  const clean = (fenced ? fenced[1] : candidate)
    .replace(/\s+/gu, ' ')
    .replace(QUOTES, '')
    .trim();
  if (!clean || clean.length > 2000) return source;
  const ratio = clean.length / source.length;
  // A repair changes a few words; a rewrite changes most of the sentence.
  if (ratio < 0.45 || ratio > 2.2) return source;
  return clean;
}

async function collect(chunks) {
  let text = '';
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message || '校正失败');
    else if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('校正已取消');
  }
  return text;
}

/**
 * Repair one transcript. Never throws and never blocks the task: any failure returns the
 * raw text. `reasoningEffort: 'off'` is the non-thinking Flash route — this must be fast
 * and literal, not clever.
 */
export async function correctTranscript({ llm, raw, signal, provider = 'deepseek-account', model = 'deepseek-flash', timeoutMs = 2500 } = {}) {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source || !llm || typeof llm.stream !== 'function') return source;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('校正超时')), Math.max(250, timeoutMs));
  const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const stream = llm.stream({
      provider,
      model,
      reasoningEffort: 'off',
      system: CORRECTION_SYSTEM,
      temperature: 0,
      maxTokens: 240,
      messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
      signal: scoped,
    });
    return sanitizeCorrection(source, await collect(stream));
  } catch {
    return source;
  } finally {
    clearTimeout(timer);
  }
}
