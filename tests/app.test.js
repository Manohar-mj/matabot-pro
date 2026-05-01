/**
 * MataBot — Unit Tests
 * tests/app.test.js
 *
 * Covers: input validation, markdown formatting,
 *         escape helpers, rate-limit logic, state management
 */

/* ── Helpers extracted from app (testable pure functions) ─── */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function validateMessage(content) {
  if (typeof content !== 'string') return { valid: false, reason: 'Not a string' };
  const trimmed = content.trim();
  if (trimmed.length === 0) return { valid: false, reason: 'Empty message' };
  if (trimmed.length > 2000) return { valid: false, reason: 'Message too long (max 2000 chars)' };
  return { valid: true, content: trimmed };
}

function validateRole(role) {
  return ['user', 'assistant', 'system'].includes(role);
}

function isRateLimited(count, windowStart, now, limit = 30, windowMs = 3_600_000) {
  const inWindow = windowStart > now - windowMs;
  return inWindow && count >= limit;
}

let _stepCounter = 0;
function resetStepCounter() { _stepCounter = 0; }

function formatMarkdown(raw) {
  _stepCounter = 0;
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#{1,3} (.+)$/gm, (_, t) => `<HEADING>${t}</HEADING>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/^\d+\. (.+)$/gm, (_, c) => { _stepCounter++; return `<STEP num="${_stepCounter}">${c}</STEP>`; })
    .replace(/^[-•] (.+)$/gm,  (_, c) => `<BULLET>${c}</BULLET>`)
    .replace(/\n\n/g, '<PARA>')
    .replace(/\n/g, '<BR>');
}

function truncateTitle(text, maxLen = 80) {
  if (typeof text !== 'string') return '';
  return text.slice(0, maxLen);
}

function buildSystemPrompt(faqs = []) {
  const faqSection = faqs.length
    ? '\n\n## ADDITIONAL FAQs FROM ADMIN:\n' + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : '';
  return `You are MataBot, India's election assistant.${faqSection}`;
}

/* ═══════════════════════════════════════════════
   TEST SUITES
   ═══════════════════════════════════════════════ */

describe('escapeHtml', () => {
  test('escapes < and > characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
  test('escapes & character', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
  test('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });
  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
  test('handles non-string input by coercing', () => {
    expect(escapeHtml(42)).toBe('42');
  });
  test('does not escape plain text', () => {
    expect(escapeHtml('Hello India')).toBe('Hello India');
  });
});

describe('validateMessage', () => {
  test('accepts valid message', () => {
    const result = validateMessage('How does voting work in India?');
    expect(result.valid).toBe(true);
    expect(result.content).toBe('How does voting work in India?');
  });
  test('rejects empty string', () => {
    expect(validateMessage('').valid).toBe(false);
  });
  test('rejects whitespace-only string', () => {
    expect(validateMessage('   ').valid).toBe(false);
  });
  test('rejects message over 2000 chars', () => {
    expect(validateMessage('a'.repeat(2001)).valid).toBe(false);
  });
  test('trims whitespace from valid message', () => {
    expect(validateMessage('  EVM  ').content).toBe('EVM');
  });
  test('rejects non-string', () => {
    expect(validateMessage(null).valid).toBe(false);
  });
  test('accepts exactly 2000 chars', () => {
    expect(validateMessage('a'.repeat(2000)).valid).toBe(true);
  });
});

describe('validateRole', () => {
  test('accepts user role', () => expect(validateRole('user')).toBe(true));
  test('accepts assistant role', () => expect(validateRole('assistant')).toBe(true));
  test('accepts system role', () => expect(validateRole('system')).toBe(true));
  test('rejects invalid role', () => expect(validateRole('admin')).toBe(false));
  test('rejects empty string', () => expect(validateRole('')).toBe(false));
});

describe('isRateLimited', () => {
  const now = Date.now();
  test('not limited when count below threshold', () => {
    expect(isRateLimited(29, now - 100, now)).toBe(false);
  });
  test('limited when count equals threshold', () => {
    expect(isRateLimited(30, now - 100, now)).toBe(true);
  });
  test('not limited when window has expired', () => {
    expect(isRateLimited(30, now - 4_000_000, now)).toBe(false);
  });
  test('not limited at count 0', () => {
    expect(isRateLimited(0, now, now)).toBe(false);
  });
  test('respects custom limit', () => {
    expect(isRateLimited(5, now, now, 5)).toBe(true);
    expect(isRateLimited(4, now, now, 5)).toBe(false);
  });
});

describe('formatMarkdown', () => {
  test('converts **bold** to <strong>', () => {
    expect(formatMarkdown('**EVM**')).toContain('<strong>EVM</strong>');
  });
  test('converts *italic* to <em>', () => {
    expect(formatMarkdown('*NOTA*')).toContain('<em>NOTA</em>');
  });
  test('converts ## heading', () => {
    expect(formatMarkdown('## Election Process')).toContain('<HEADING>Election Process</HEADING>');
  });
  test('converts numbered list item', () => {
    const result = formatMarkdown('1. Register to vote');
    expect(result).toContain('<STEP num="1">Register to vote</STEP>');
  });
  test('numbers list items sequentially', () => {
    const result = formatMarkdown('1. First\n2. Second\n3. Third');
    expect(result).toContain('num="1"');
    expect(result).toContain('num="2"');
    expect(result).toContain('num="3"');
  });
  test('converts bullet list item', () => {
    expect(formatMarkdown('- Lok Sabha')).toContain('<BULLET>Lok Sabha</BULLET>');
  });
  test('escapes HTML before formatting', () => {
    expect(formatMarkdown('<b>test</b>')).toContain('&lt;b&gt;');
  });
  test('converts double newline to paragraph break', () => {
    expect(formatMarkdown('Para 1\n\nPara 2')).toContain('<PARA>');
  });
  test('handles empty string', () => {
    expect(formatMarkdown('')).toBe('');
  });
});

describe('truncateTitle', () => {
  test('returns string up to maxLen', () => {
    expect(truncateTitle('Hello World', 5)).toBe('Hello');
  });
  test('returns full string if shorter than maxLen', () => {
    expect(truncateTitle('Hi', 10)).toBe('Hi');
  });
  test('handles non-string input', () => {
    expect(truncateTitle(null)).toBe('');
    expect(truncateTitle(undefined)).toBe('');
  });
  test('defaults to 80 char limit', () => {
    const long = 'a'.repeat(100);
    expect(truncateTitle(long).length).toBe(80);
  });
});

describe('buildSystemPrompt', () => {
  test('returns base prompt with no FAQs', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain('MataBot');
    expect(prompt).not.toContain('ADDITIONAL FAQs');
  });
  test('includes FAQs when provided', () => {
    const faqs = [{ question: 'What is NOTA?', answer: 'None of the Above.' }];
    const prompt = buildSystemPrompt(faqs);
    expect(prompt).toContain('What is NOTA?');
    expect(prompt).toContain('None of the Above.');
  });
  test('handles multiple FAQs', () => {
    const faqs = [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ];
    const prompt = buildSystemPrompt(faqs);
    expect(prompt).toContain('Q1');
    expect(prompt).toContain('Q2');
  });
});

describe('formatDate', () => {
  test('formats a valid date object', () => {
    const result = formatDate(new Date('2024-04-19'));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
  test('returns empty string for null', () => {
    expect(formatDate(null)).toBe('');
  });
  test('returns empty string for undefined', () => {
    expect(formatDate(undefined)).toBe('');
  });
  test('handles Firestore timestamp-like object', () => {
    const fakeTs = { toDate: () => new Date('2024-05-01') };
    const result = formatDate(fakeTs);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
