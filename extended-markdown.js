import { gemoji } from 'gemoji';
import highlighter from 'highlight.js/lib/common';

const emojiByName = new Map(gemoji.flatMap(({ names, emoji }) => names.map(name => [name, emoji])));
export const emojiPattern = /^:([\w+-]+):/;
export const highlightPattern = /^==(?!=)(\S(?:[^\n]*?\S)?)==(?!=)/;
export const headingIdPattern = /[ \t]+\{#([\p{L}\p{N}_.:-]+)\}$/u;

export function shortcodeEmoji(shortcode) {
  return emojiByName.get(emojiPattern.exec(shortcode)?.[1]);
}

function highlightCode(source, info) {
  const language = info?.match(/^\S+/)?.[0].toLowerCase();
  if (!language || !highlighter.getLanguage(language)) return;
  return highlighter.highlight(source, { language, ignoreIllegals:true }).value;
}

export function codeHighlightRanges(source, info) {
  const html = highlightCode(source, info);
  if (!html) return [];
  const ranges = [], spans = [];
  let offset = 0;
  // Highlight.js emits spans and escaped text. Map those tokens to source offsets.
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (match[1]) spans.push({ from:offset, className:match[1] });
    else if (match[0] === '</span>') {
      const span = spans.pop();
      if (span.from < offset) ranges.push({ ...span, to:offset });
    } else {
      offset += match[0].replace(/&(?:amp|lt|gt|quot|#x27);/g, ' ').length;
    }
  }
  return ranges;
}

function inlineFormatting(name, marker, pattern, tag) {
  return {
    name, level:'inline',
    start(source) { return source.indexOf(marker); },
    tokenizer(source) {
      const match = pattern.exec(source);
      if (match) return { type:name, raw:match[0], tokens:this.lexer.inlineTokens(match[1]) };
    },
    renderer({ tokens }) { return `<${tag}>${this.parser.parseInline(tokens)}</${tag}>`; }
  };
}

const definitionStart = /^( {0,3})(?![ \t]|#{1,6}(?:[ \t]|$)|>|\x60{3}|~{3}|[-+*][ \t]|\d{1,9}[.)][ \t]|<|\[\^)[^\n]+\n {0,3}:[ \t]+\S/m;
const definitionTerm = /^[^\n]+\n/;
const definitionBody = /^ {0,3}:[ \t]+([^\n]+(?:\n(?:[ \t]*\n)*(?: {4}|\t)[^\n]*)*)(?:\n|$)/;
const footnoteStart = /^ {0,3}\[\^([^\s\]]+)\]:[ \t]*/m;
const footnoteDefinition = /^ {0,3}\[\^([^\s\]]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]*\n)*(?: {4}|\t)[^\n]*)*)(?:\n|$)/;
const dedent = source => source.replace(/\n(?: {4}|\t)/g, '\n');

export function extendedMarkdown(renderId) {
  const definitions = new Map();
  const references = new Map();
  const renderedNotes = new Map();
  const noteSlot = `md-footnote-${renderId}-`;
  const noteMarker = new RegExp(`<!--${noteSlot}(\\d+)-->`, 'g');
  const noteGroup = new RegExp(`(?:${noteMarker.source}\\s*)+`, 'g');
  return {
    hooks:{
      preprocess(source) {
        definitions.clear();
        references.clear();
        renderedNotes.clear();
        return source;
      },
      processAllTokens(tokens) {
        // Collect return links after the document is rendered, then fill each definition's slot.
        if (definitions.size) tokens.push({ type:'resolveFootnotes', raw:'' });
        return tokens;
      },
      postprocess(html) {
        return html.replace(noteGroup, group => {
          const items = [...group.matchAll(noteMarker)].map(([, slot]) => renderedNotes.get(Number(slot))).join('');
          return items ? `<section class="footnotes" aria-label="Footnotes"><hr><ol>${items}</ol></section>\n` : '';
        });
      }
    },
    tokenizer:{
      // GFM's single tilde overlaps with subscript. Keep double tildes for strikethrough.
      del(source) { if (source.startsWith('~~')) return false; }
    },
    renderer:{
      heading(token) {
        const match = headingIdPattern.exec(token.text);
        const tail = token.tokens.at(-1);
        if (!match || tail?.type !== 'text' || !tail.text.endsWith(match[0])) return false;
        const tokens = [...token.tokens.slice(0, -1), { ...tail, text:tail.text.slice(0, -match[0].length) }];
        return `<h${token.depth} id="${match[1]}">${this.parser.parseInline(tokens)}</h${token.depth}>\n`;
      },
      code({ text, lang }) {
        const value = highlightCode(text, lang);
        if (value === undefined) return false;
        return `<pre><code class="hljs">${value}\n</code></pre>\n`;
      }
    },
    extensions:[
      inlineFormatting('highlight', '==', highlightPattern, 'mark'),
      inlineFormatting('subscript', '~', /^~(?!~)([^\s~]+)~(?!~)/, 'sub'),
      inlineFormatting('superscript', '^', /^\^(?!\^)([^\s^]+)\^(?!\^)/, 'sup'),
      {
        name:'shortcodeEmoji', level:'inline',
        start(source) {
          // Leave ordinary colons, including the one in a URL scheme, to Marked.
          for (const match of source.matchAll(/(?=:([\w+-]+):)/g)) {
            if (emojiByName.has(match[1])) return match.index;
          }
        },
        tokenizer(source) {
          const match = emojiPattern.exec(source);
          const emoji = match && emojiByName.get(match[1]);
          if (emoji) return { type:'shortcodeEmoji', raw:match[0], emoji };
        },
        renderer({ emoji }) { return emoji; }
      },
      {
        name:'definitionList', level:'block', childTokens:['terms', 'bodies'],
        start(source) { return source.search(definitionStart); },
        tokenizer(source) {
          let rest = source;
          const terms = [], bodies = [];
          while (rest.search(definitionStart) === 0) {
            const term = definitionTerm.exec(rest)[0];
            rest = rest.slice(term.length);
            terms.push(this.lexer.inline(term.trim()));
            const definitions = [];
            let match;
            while ((match = definitionBody.exec(rest))) {
              definitions.push(this.lexer.blockTokens(dedent(match[1]), []));
              rest = rest.slice(match[0].length);
            }
            bodies.push(definitions);
            const next = rest.trimStart();
            if (next.search(definitionStart) === 0) rest = next;
          }
          if (terms.length) return { type:'definitionList', raw:source.slice(0, source.length - rest.length), terms, bodies };
        },
        renderer({ terms, bodies }) {
          const items = terms.map((term, index) => `<dt>${this.parser.parseInline(term)}</dt>` +
            bodies[index].map(tokens => `<dd>${this.parser.parse(tokens)}</dd>`).join(''));
          return `<dl>${items.join('')}</dl>\n`;
        }
      },
      {
        name:'footnoteDefinition', level:'block', childTokens:['tokens'],
        start(source) { return source.search(footnoteStart); },
        tokenizer(source) {
          const match = footnoteDefinition.exec(source);
          if (!match) return;
          const token = { type:'footnoteDefinition', raw:match[0], tokens:[] };
          if (!definitions.has(match[1])) {
            token.slot = definitions.size;
            definitions.set(match[1], token);
            this.lexer.blockTokens(dedent(match[2]), token.tokens);
          }
          return token;
        },
        renderer({ slot }) { return slot === undefined ? '' : `<!--${noteSlot}${slot}-->\n`; }
      },
      {
        name:'footnoteReference', level:'inline',
        start(source) { return source.indexOf('[^'); },
        tokenizer(source) {
          const match = /^\[\^([^\s\]]+)\]/.exec(source);
          if (match && !this.lexer.state.inLink && definitions.has(match[1])) {
            return { type:'footnoteReference', raw:match[0], label:match[1] };
          }
        },
        renderer({ label }) {
          if (!references.has(label)) references.set(label, { number:references.size + 1, count:0 });
          const ref = references.get(label);
          return `<sup><a class="footnote-reference" id="md-fnref-${ref.number}-${++ref.count}" href="#md-fn-${ref.number}" aria-label="Footnote ${ref.number}">${ref.number}</a></sup>`;
        }
      },
      {
        name:'resolveFootnotes',
        renderer() {
          const notes = [];
          // A footnote body can introduce another reference.
          for (const [label, ref] of references) {
            const { slot, tokens } = definitions.get(label);
            notes.push({ slot, ref, body:this.parser.parse(tokens).trimEnd() });
          }
          for (const { slot, ref:{ number, count }, body } of notes) {
            const back = Array.from({ length:count }, (_, i) =>
              `<a class="footnote-return" href="#md-fnref-${number}-${i + 1}" aria-label="Back to footnote ${number}, reference ${i + 1}">↩</a>`).join(' ');
            const content = body.endsWith('</p>') ? `${body.slice(0, -4)} ${back}</p>` : `${body} ${back}`;
            renderedNotes.set(slot, `<li class="footnote-item" id="md-fn-${number}" value="${number}" tabindex="-1">${content}</li>`);
          }
          return '';
        }
      }
    ]
  };
}
