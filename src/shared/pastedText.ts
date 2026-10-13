/** 粘贴纯文本转 txt 附件的门槛（参考 lody）：统一换行、去首尾空白后计数 */
export const PASTED_TEXT_FILE_MIN_CHARS = 50_000;
/** IPC 单次上限，超出则保持原样插入正文 */
export const PASTED_TEXT_FILE_MAX_CHARS = 20_000_000;
export const PASTED_TEXT_FILE_NAME = 'pasted-text.txt';

export type PastedTextFileResult =
  | { ok: true; path: string; chars: number; lines: number }
  | { ok: false; error: string };

/** 达到门槛时返回要落盘的规范化文本，否则 null（走原有插入正文） */
export function pastedTextFileContent(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  return normalized.length >= PASTED_TEXT_FILE_MIN_CHARS &&
    normalized.length <= PASTED_TEXT_FILE_MAX_CHARS
    ? normalized
    : null;
}
