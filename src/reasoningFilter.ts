/** Filters out OmniRoute encrypted/private reasoning notice messages,
 * even when streamed across multiple incremental SSE text chunks. */
export class EncryptedReasoningFilter {
  private buffer = "";
  private static readonly NOTICE =
    "codex is reasoning, but upstream responses api exposed this reasoning block only as encrypted private reasoning. omniroute cannot recover plaintext.";
  private static readonly REQUEST_NOTICE = "omniroute: got req, sending to provider";
  private static readonly NOTICE_VARIANT =
    "codex is reasoning, but the upstream responses api exposed this reasoning block only as encrypted private reasoning. omniroute cannot recover the plaintext.";
  private static readonly REQUEST_NOTICE_VARIANT = "omniroute: got request, sending to provider";
  private static readonly COMPLETE_NOTICE_PATTERN = /codex is reasoning, but upstream responses api exposed this reasoning block only as encrypted private reasoning\. omniroute cannot recover plaintext\.|omniroute: got req, sending to provider|codex is reasoning, but the upstream responses api exposed this reasoning block only as encrypted private reasoning\. omniroute cannot recover the plaintext\.|omniroute: got request, sending to provider/g;

  private static readonly KNOWN_PATTERNS = [
    "codex is reasoning, but upstream responses api exposed this reasoning block only as encrypted private reasoning. omniroute cannot recover plaintext.",
    "codex is reasoning, but the upstream responses api exposed this reasoning block only as encrypted private reasoning. omniroute cannot recover the plaintext.",
    "omniroute: got req, sending to provider",
    "omniroute: got request, sending to provider",
    "upstream responses api exposed this reasoning block only as encrypted private reasoning",
    "encrypted private reasoning. omniroute cannot recover plaintext",
    "omniroute cannot recover plaintext",
    "encrypted private reasoning",
  ];

  public push(chunk: string): string[] {
    if (!chunk && !this.buffer) return [];
    this.buffer += chunk;
    const normalized = this.buffer.toLowerCase();
    const output: string[] = [];
    let cursor = 0;

    for (const match of normalized.matchAll(EncryptedReasoningFilter.COMPLETE_NOTICE_PATTERN)) {
      const matchIndex = match.index;
      const before = this.buffer.slice(cursor, matchIndex);
      if (before) output.push(before);
      cursor = matchIndex + match[0].length;
    }

    const remainingNormalized = normalized.slice(cursor);
    let prefixLength = 0;
    const maxNoticeLength = Math.max(
      EncryptedReasoningFilter.NOTICE.length,
      EncryptedReasoningFilter.NOTICE_VARIANT.length
    );
    for (let length = Math.min(maxNoticeLength - 1, remainingNormalized.length); length >= 5; length--) {
      if (remainingNormalized.endsWith(EncryptedReasoningFilter.NOTICE.slice(0, length)) ||
          remainingNormalized.endsWith(EncryptedReasoningFilter.REQUEST_NOTICE.slice(0, length)) ||
          remainingNormalized.endsWith(EncryptedReasoningFilter.NOTICE_VARIANT.slice(0, length)) ||
          remainingNormalized.endsWith(EncryptedReasoningFilter.REQUEST_NOTICE_VARIANT.slice(0, length))) {
        prefixLength = length;
        break;
      }
    }

    const emitEnd = this.buffer.length - prefixLength;
    if (emitEnd > cursor) output.push(this.buffer.slice(cursor, emitEnd));
    this.buffer = this.buffer.slice(emitEnd);
    return output;
  }

  public flush(): string[] {
    if (!this.buffer) return [];
    const normalized = this.buffer.trim().toLowerCase().replace(/\s+/g, " ");
    for (const pattern of EncryptedReasoningFilter.KNOWN_PATTERNS) {
      if (normalized.includes(pattern) || pattern.startsWith(normalized)) {
        this.buffer = "";
        return [];
      }
    }
    const out = this.buffer;
    this.buffer = "";
    return [out];
  }
}
