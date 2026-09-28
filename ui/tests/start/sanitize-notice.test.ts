// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeNoticeHtml } from '../../src/start/sanitize-notice';

// A notification body is remote HTML rendered in a page that holds the shell
// bridge. Only formatting and http(s) links may survive.

function sanitized(html: string): string {
  const holder = document.createElement('div');
  holder.appendChild(sanitizeNoticeHtml(html));
  return holder.innerHTML;
}

describe('sanitizeNoticeHtml', () => {
  it('keeps formatting and http(s) links', () => {
    expect(sanitized('<p><b>New:</b> <em>read</em> <a href="https://fluidcad.io/blog">this</a></p>')).toBe(
      '<p><b>New:</b> <em>read</em> <a href="https://fluidcad.io/blog">this</a></p>',
    );
    expect(sanitized('<a href="http://example.com">x</a>')).toBe('<a href="http://example.com">x</a>');
  });

  it('drops scripts, iframes, SVG and styles with their content', () => {
    expect(sanitized('a<script>alert(1)</script>b')).toBe('ab');
    expect(sanitized('a<iframe src="https://evil.example"></iframe>b')).toBe('ab');
    expect(sanitized('a<svg><script>alert(1)</script><circle r="1"/></svg>b')).toBe('ab');
    expect(sanitized('a<style>body{display:none}</style>b')).toBe('ab');
    expect(sanitized('a<math><mi>x</mi></math>b')).toBe('ab');
  });

  it('strips every event handler and style attribute', () => {
    expect(sanitized('<b onclick="alert(1)" style="color:red" class="x">bold</b>')).toBe('<b>bold</b>');
    expect(sanitized('<a href="https://ok.example" onmouseover="alert(1)">x</a>')).toBe('<a href="https://ok.example">x</a>');
  });

  it('removes javascript: and other non-http links', () => {
    expect(sanitized('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitized('<a href="  javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitized('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe('<a>x</a>');
    expect(sanitized('<a href="fluidcad-app://start/start.html">x</a>')).toBe('<a>x</a>');
  });

  it('drops foreign content whatever case its tag names report', () => {
    expect(sanitized('a<svg><a href="https://ok.example">x</a><foreignObject><b>y</b></foreignObject></svg>b')).toBe('ab');
    expect(sanitized('a<SVG><SCRIPT>alert(1)</SCRIPT></SVG>b')).toBe('ab');
  });

  it('unwraps unknown elements to their text and drops images', () => {
    expect(sanitized('<div><form><button>go</button></form></div>')).toBe('go');
    expect(sanitized('x<img src="x" onerror="alert(1)">y')).toBe('xy');
  });
});
