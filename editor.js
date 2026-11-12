import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection } from '@codemirror/view';
import {
  cursorGroupLeft, cursorGroupRight, cursorLineUp, cursorLineDown,
  defaultKeymap, history, historyKeymap, indentWithTab,
  selectGroupLeft, selectGroupRight, selectLineUp, selectLineDown
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { createInlineImage, matchInlineImage } from './inline-image.js';

export { createInlineImage, localFileUrl, matchInlineImage } from './inline-image.js';

const inlineImageSyntax = {
  defineNodes:['InlineImage'],
  parseInline:[{
    name:'InlineImage',
    before:'Image',
    parse(context, next, position) {
      if (next !== 33 || context.slice(position, position + 3) !== '![[') return -1;
      const match = matchInlineImage(context.slice(position, context.end));
      return match ? context.addElement(context.elt('InlineImage', position, position + match.raw.length)) : -1;
    }
  }]
};

class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.textContent = '•';
    span.className = 'md-bullet';
    return span;
  }
}

class Task extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'md-task';
    input.setAttribute('aria-label', 'Toggle task');
    input.addEventListener('change', () => {
      view.dispatch({ changes:{ from:this.from, to:this.from + 3, insert:input.checked ? '[x]' : '[ ]' } });
    });
    return input;
  }
}

class InlineImage extends WidgetType {
  constructor(from, target, baseUrl) {
    super();
    this.from = from;
    this.target = target;
    this.baseUrl = baseUrl;
  }
  eq(other) { return this.from === other.from && this.target === other.target && this.baseUrl === other.baseUrl; }
  toDOM(view) {
    const element = createInlineImage(this.target, this.baseUrl);
    element.addEventListener('mousedown', event => event.preventDefault());
    element.addEventListener('click', () => {
      view.dispatch({ selection:{ anchor:this.from + 3 } });
      view.focus();
    });
    return element;
  }
}

function decorations(view, imageBaseUrl) {
  const { state } = view;
  const ranges = [], lines = new Map();
  const selectedLines = state.selection.ranges.map(range => ({
    from:state.doc.lineAt(range.from).from, to:state.doc.lineAt(range.to).to
  }));
  const active = (from, to) => selectedLines.some(line => from <= line.to && to >= line.from);
  // Keep completed syntax visible while the caret is directly after its closing marker.
  const revealInlineSource = (from, to) => state.selection.ranges.some(range =>
    range.empty ? range.head > from && range.head <= to : range.from < to && range.to > from);
  const lineClass = (position, name) => {
    const from = state.doc.lineAt(position).from;
    if (!lines.has(from)) lines.set(from, new Set());
    lines.get(from).add(name);
  };
  const mark = (from, to, name, attributes) => {
    if (from < to) ranges.push(Decoration.mark({ class:name, attributes }).range(from, to));
  };
  const hide = (from, to, widget, reveal = active(from, to)) => {
    if (from >= to) return;
    if (reveal) mark(from, to, 'md-syntax');
    else ranges.push(Decoration.replace(widget ? { widget } : {}).range(from, to));
  };
  const visitChildren = (node, callback) => {
    for (let child = node.firstChild; child; child = child.nextSibling) callback(child);
  };

  const hideLinkSuffix = (from, to, reveal) => {
    // View-plugin replacements cannot span a line break.
    for (let start = from; start < to;) {
      const end = Math.min(state.doc.lineAt(start).to, to);
      hide(start, end, undefined, reveal);
      start = end + 1;
    }
  };

  let inlineLink;
  for (const visible of view.visibleRanges) syntaxTree(state).iterate({
    from:visible.from, to:visible.to,
    enter(cursor) {
      const node = cursor.node, { name, from, to } = node;
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) lineClass(from, `md-h${heading[1]}`);
      if (name === 'HeaderMark') {
        // Consume the separating space too, so hidden heading markers do not indent text.
        let end = to;
        if (state.sliceDoc(end, end + 1) === ' ') end++;
        hide(from, end);
      }
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough' || name === 'InlineCode') {
        const className = { StrongEmphasis:'md-bold', Emphasis:'md-italic', Strikethrough:'md-strike', InlineCode:'md-inline-code' }[name];
        mark(from, to, className);
      }
      if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark') {
        const parent = node.parent;
        const reveal = parent?.name === 'StrongEmphasis'
          ? revealInlineSource(parent.from, parent.to)
          : inlineLink?.reveal;
        hide(from, to, undefined, reveal);
      }
      if (name === 'ListMark' && !/^\d/.test(state.sliceDoc(from, to))) hide(from, to, new Bullet());
      if (name === 'TaskMarker') hide(from, to, new Task(from, /x/i.test(state.sliceDoc(from, to))));
      if (name === 'QuoteMark') { lineClass(from, 'md-quote'); hide(from, to); }
      if (name === 'InlineImage') {
        const { target } = matchInlineImage(state.sliceDoc(from, to));
        hide(from, to, new InlineImage(from, target, imageBaseUrl), revealInlineSource(from, to));
        return false;
      }
      if (name === 'Link') {
        const opening = node.firstChild;
        const closing = node.lastChild;
        const labelEnd = node.getChild('LinkMark', 'LinkMark');
        if (opening?.name === 'LinkMark' && closing?.name === 'LinkMark' &&
            labelEnd && state.sliceDoc(closing.from, closing.to) === ')') {
          const reveal = revealInlineSource(from, to);
          inlineLink = { from, to, reveal };
          hide(opening.from, opening.to, undefined, reveal);
          hideLinkSuffix(labelEnd.from, to, reveal);
          mark(opening.to, labelEnd.from, 'md-link', {
            'data-md-link':state.sliceDoc(from, to),
            title:'⌘-click to open link'
          });
          return;
        }
        // An unfinished inline link can parse as a shortcut reference followed by '('.
        if (state.sliceDoc(to, to + 1) === '(') return;
      }
      if (name === 'Link' || name === 'Image') {
        visitChildren(node, child => {
          if (child.name === 'LinkMark' || child.name === 'URL' || child.name === 'LinkTitle') hide(child.from, child.to);
        });
        mark(from, to, name === 'Link' ? 'md-link' : 'md-image');
        // Children are handled here so link markers are never replaced twice.
        return false;
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = state.doc.lineAt(Math.max(from, visible.from));
        const last = state.doc.lineAt(Math.min(to, visible.to));
        for (let number = first.number; number <= last.number; number++) lineClass(state.doc.line(number).from, 'md-code-line');
      }
      if (name === 'CodeInfo') hide(from, to);
      if (name === 'HorizontalRule') lineClass(from, 'md-rule');
    },
    leave({ name, from, to }) {
      if (name === 'Link' && inlineLink?.from === from && inlineLink.to === to) inlineLink = undefined;
    }
  });
  for (const [from, names] of lines) ranges.push(Decoration.line({ class:[...names].join(' ') }).range(from));
  return Decoration.set(ranges, true);
}

function livePreview(getImageBaseUrl) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.imageBaseUrl = getImageBaseUrl();
      this.decorations = decorations(view, this.imageBaseUrl);
    }
    update(update) {
      const baseUrl = getImageBaseUrl();
      if (baseUrl !== this.imageBaseUrl || update.docChanged || update.selectionSet || update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.imageBaseUrl = baseUrl;
        this.decorations = decorations(update.view, baseUrl);
      }
    }
  }, { decorations:plugin => plugin.decorations });
}

function toggleInline(delimiter, nodeName) {
  return view => {
    const { state } = view;
    const range = state.selection.main;
    let node = syntaxTree(state).resolveInner(range.head, -1);
    while (node && node.name !== nodeName) node = node.parent;
    if (node && range.from >= node.from && range.to <= node.to) {
      const first = node.firstChild, last = node.lastChild;
      if (first && last && first !== last) {
        const changes = state.changes([{ from:first.from, to:first.to }, { from:last.from, to:last.to }]);
        view.dispatch({
          changes,
          selection:EditorSelection.range(changes.mapPos(range.anchor, 1), changes.mapPos(range.head, -1))
        });
        return true;
      }
    }
    view.dispatch({
      changes:{ from:range.from, to:range.to, insert:delimiter + state.sliceDoc(range.from, range.to) + delimiter },
      selection:EditorSelection.range(range.from + delimiter.length, range.to + delimiter.length)
    });
    return true;
  };
}

const theme = EditorView.theme({
  '&':{ backgroundColor:'transparent', color:'#30342e', fontSize:'17px' },
  '&.cm-focused':{ outline:'none' },
  '.cm-scroller':{ fontFamily:'system-ui,-apple-system,sans-serif', lineHeight:'1.7', overflow:'visible' },
  '.cm-content':{ padding:'0', minHeight:'50vh', caretColor:'#24684d' },
  '.cm-line':{ padding:'0', margin:'0', minHeight:'1.7em' },
  '.cm-h1, .md-h1':{ fontSize:'1.65em', fontWeight:'700', lineHeight:'1.4', minHeight:'1.4em' },
  '.md-h2':{ fontSize:'1.4em', fontWeight:'650', lineHeight:'1.45', minHeight:'1.45em' },
  '.md-h3':{ fontSize:'1.2em', fontWeight:'650', minHeight:'1.5em' },
  '.md-h4, .md-h5, .md-h6':{ fontWeight:'650' },
  '.md-bold':{ fontWeight:'700' }, '.md-italic':{ fontStyle:'italic' }, '.md-strike':{ textDecoration:'line-through' },
  '.md-syntax':{ color:'#97998e', fontWeight:'400', textDecoration:'none' },
  '.md-inline-code':{ fontFamily:'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize:'.9em', backgroundColor:'#eeede7', borderRadius:'3px' },
  '.md-code-line':{ fontFamily:'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize:'.88em', backgroundColor:'#eeede7', padding:'0 12px' },
  '.md-quote':{ borderLeft:'3px solid #a2b8a4', paddingLeft:'14px', color:'#686862' },
  '.md-link':{ color:'#24684d', textDecoration:'underline', textUnderlineOffset:'3px' },
  '.md-image':{ color:'#77776e' }, '.md-bullet':{ color:'#7e897a' },
  '.md-inline-image':{ maxWidth:'100%', height:'auto', verticalAlign:'middle', cursor:'text' },
  '.md-task':{ accentColor:'#24684d', verticalAlign:'middle', margin:'0 4px 0 0' },
  '.md-rule':{ color:'#a6a99c', borderBottom:'1px solid #d9d9d0' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground':{ backgroundColor:'#cde2d4' },
  '.cm-cursor':{ borderLeftColor:'#24684d' }
});

function commandClickedLink(event) {
  if (event.button !== 0 || !event.metaKey || !(event.target instanceof Element)) return;
  return event.target.closest('[data-md-link]')?.dataset.mdLink;
}

const optionArrowKeymap = [
  ['ArrowLeft', cursorGroupLeft, selectGroupLeft],
  ['ArrowRight', cursorGroupRight, selectGroupRight],
  ['ArrowUp', cursorLineUp, selectLineUp],
  ['ArrowDown', cursorLineDown, selectLineDown]
].flatMap(([key, move, select]) => [
  ['Alt', move], ['Ctrl-Alt', select], ['Shift-Alt', select]
].map(([modifiers, command]) => ({
  key:`${modifiers}-${key}`,
  run(view) {
    command(view);
    // Consume the shortcut at document boundaries to prevent fallback line moves or copies.
    return true;
  }
})));

function selectedMarkdown(state) {
  return state.selection.ranges.filter(range => !range.empty).map(range => state.sliceDoc(range.from, range.to));
}

export function createEditor(parent, source, onChange, openLink, getImageBaseUrl, onSelectionChange) {
  const view = new EditorView({
    parent,
    // The supplied ShadowRoot keeps selection and style handling inside the extension.
    root:parent.getRootNode(),
    state:EditorState.create({ doc:source, extensions:[
      markdown({ base:markdownLanguage, extensions:[inlineImageSyntax] }), history(), drawSelection(),
      EditorView.lineWrapping, livePreview(getImageBaseUrl), theme,
      syntaxHighlighting(HighlightStyle.define([{ tag:tags.processingInstruction, color:'#97998e' }])),
      EditorView.contentAttributes.of({ 'aria-label':'Markdown live preview', spellcheck:'true' }),
      EditorView.domEventHandlers({
        mousedown(event) {
          if (!commandClickedLink(event)) return false;
          // Keep the caret from moving and replacing the label before the click.
          event.preventDefault();
          return true;
        },
        click(event) {
          const link = commandClickedLink(event);
          if (!link) return false;
          event.preventDefault();
          openLink(link);
          return true;
        }
      }),
      keymap.of([
        { key:'Mod-b', run:toggleInline('**', 'StrongEmphasis') },
        { key:'Mod-i', run:toggleInline('*', 'Emphasis') },
        ...optionArrowKeymap,
        ...historyKeymap, ...defaultKeymap, indentWithTab
      ]),
      EditorState.lineSeparator.of(source.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.updateListener.of(update => {
        if (update.docChanged) onChange(update.state.sliceDoc());
        if (update.docChanged || !update.state.selection.eq(update.startState.selection)) {
          onSelectionChange(selectedMarkdown(update.state));
        }
      })
    ] })
  });
  return {
    focus:() => view.focus(),
    blur:() => view.contentDOM.blur(),
    requestMeasure:() => view.requestMeasure(),
    refreshImages:() => view.dispatch({}),
    selectedMarkdown:() => selectedMarkdown(view.state)
  };
}
