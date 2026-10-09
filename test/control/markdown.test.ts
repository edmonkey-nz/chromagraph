import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/client/control/markdown.ts';

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, lists, code and rules', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code`.\nSame paragraph.\n\n- one\n- two\n\n1. first\n2. second\n\n---\n\n```\nnpm run dev\n```');
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<p>Some <strong>bold</strong> and <em>italic</em> and <code>code</code>. Same paragraph.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code>npm run dev</code></pre>');
  });

  it('escapes HTML and refuses unsafe links', () => {
    const html = renderMarkdown('<script>alert(1)</script> [ok](https://example.org) [bad](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener">ok</a>');
    expect(html).not.toContain('javascript:');
  });

  it('keeps code spans unformatted', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });
});
