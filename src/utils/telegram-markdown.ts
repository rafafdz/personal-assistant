import MarkdownIt from 'markdown-it';

/**
 * Telegram HTML Mode Supported Tags (as per official docs):
 * https://core.telegram.org/bots/api#html-style
 *
 * - <b>, <strong> - bold
 * - <i>, <em> - italic
 * - <u>, <ins> - underline
 * - <s>, <strike>, <del> - strikethrough
 * - <code> - inline code
 * - <pre> - code block
 * - <pre><code class="language-*"> - code block with syntax highlighting
 * - <a href=""> - links
 * - <span class="tg-spoiler">, <tg-spoiler> - spoiler
 *
 * NOT supported: <br>, <p>, <div>, <h1-h6>, <ul>, <ol>, <li>, <table>, etc.
 */

// Create markdown-it instance with Telegram-optimized settings
const md = new MarkdownIt({
  html: false,        // Don't allow raw HTML in markdown
  breaks: true,       // Convert \n to <br> (we'll handle this)
  linkify: true,      // Auto-convert URLs to links
  typographer: false, // Don't replace quotes/dashes
});

// Custom renderer for Telegram HTML
function createTelegramRenderer() {
  const defaultRenderer = md.renderer;

  // Helper to get text content from tokens
  function renderInline(tokens: any[], idx: number, options: any, env: any, renderer: any): string {
    let result = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'text') {
        result += token.content;
      } else if (token.type === 'code_inline') {
        result += renderer.renderToken([token], i, options);
      } else if (token.children) {
        result += renderInline(token.children, i, options, env, renderer);
      }
    }
    return result;
  }

  // Override heading renderer - convert to bold + newlines (Telegram doesn't support <h1-h6>)
  md.renderer.rules.heading_open = () => '<b>';
  md.renderer.rules.heading_close = () => '</b>\n\n';

  // Override paragraph - just add newlines (Telegram doesn't support <p>)
  md.renderer.rules.paragraph_open = () => '';
  md.renderer.rules.paragraph_close = () => '\n\n';

  // Override list - just add newlines (Telegram doesn't support <ul>, <ol>)
  md.renderer.rules.bullet_list_open = () => '';
  md.renderer.rules.bullet_list_close = () => '\n';
  md.renderer.rules.ordered_list_open = () => '';
  md.renderer.rules.ordered_list_close = () => '\n';

  // Override list item - use bullet point
  md.renderer.rules.list_item_open = () => '• ';
  md.renderer.rules.list_item_close = () => '\n';

  // Override blockquote - just indent (Telegram doesn't support <blockquote>)
  md.renderer.rules.blockquote_open = () => '';
  md.renderer.rules.blockquote_close = () => '\n';

  // Override horizontal rule (Telegram doesn't support <hr>)
  md.renderer.rules.hr = () => '———————————\n\n';

  // Override line break (Telegram doesn't support <br>)
  md.renderer.rules.hardbreak = () => '\n';
  md.renderer.rules.softbreak = () => '\n';

  // Override code block - use <pre><code>
  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    return `<pre><code>${escapeHtml(token.content)}</code></pre>\n\n`;
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const langName = info ? info.split(/\s+/g)[0] : '';

    if (langName) {
      // Telegram supports syntax highlighting with language-* class
      return `<pre><code class="language-${escapeHtml(langName)}">${escapeHtml(token.content)}</code></pre>\n\n`;
    }
    return `<pre><code>${escapeHtml(token.content)}</code></pre>\n\n`;
  };

  // Table handling - convert to plain text (Telegram doesn't support <table>)
  md.renderer.rules.table_open = () => '\n';
  md.renderer.rules.table_close = () => '\n';
  md.renderer.rules.thead_open = () => '';
  md.renderer.rules.thead_close = () => '';
  md.renderer.rules.tbody_open = () => '';
  md.renderer.rules.tbody_close = () => '';
  md.renderer.rules.tr_open = () => '';
  md.renderer.rules.tr_close = () => '\n';
  md.renderer.rules.th_open = () => '│ ';
  md.renderer.rules.th_close = () => ' ';
  md.renderer.rules.td_open = () => '│ ';
  md.renderer.rules.td_close = () => ' ';
}

// Escape HTML special characters (but we'll decode them later for Telegram)
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Decode HTML entities for Telegram (it handles raw chars better than entities)
function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // Do last to avoid double-decoding
}

// Initialize custom renderer
createTelegramRenderer();

/**
 * Convert Markdown to Telegram-compatible HTML
 */
export function markdownToTelegramHtml(markdown: string): string {
  // Render markdown to HTML
  let html = md.render(markdown);

  // Decode HTML entities (Telegram prefers raw characters)
  html = decodeHtmlEntities(html);

  // Clean up extra newlines
  html = html.replace(/\n{3,}/g, '\n\n').trim();

  return html;
}
