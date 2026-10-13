import { describe, expect, it } from 'vitest';
import { PASTED_TEXT_FILE_MIN_CHARS, pastedTextFileContent } from './pastedText';

describe('pastedTextFileContent', () => {
  it('49,999 字符保持正文，50,000 字符转文件', () => {
    expect(PASTED_TEXT_FILE_MIN_CHARS).toBe(50_000);
    expect(pastedTextFileContent('a'.repeat(49_999))).toBeNull();
    expect(pastedTextFileContent('a'.repeat(50_000))).toBe('a'.repeat(50_000));
  });

  it('CRLF / CR 统一为 \\n 后计数', () => {
    const crlf = `${'a'.repeat(24_999)}\r\n${'b'.repeat(24_999)}`;
    expect(crlf.length).toBe(50_000);
    expect(pastedTextFileContent(crlf)).toBeNull();
    const lines = `${'a'.repeat(24_999)}\r\n${'b'.repeat(25_000)}\r${'c'}`;
    expect(pastedTextFileContent(lines)).toBe(`${'a'.repeat(24_999)}\n${'b'.repeat(25_000)}\nc`);
  });

  it('首尾空白不计入，内容按去空白后的文本保存', () => {
    const padded = `  \n\t${'a'.repeat(49_999)}\n \r\n`;
    expect(pastedTextFileContent(padded)).toBeNull();
    expect(pastedTextFileContent(`\n ${'a'.repeat(50_000)} \n`)).toBe('a'.repeat(50_000));
  });
});
