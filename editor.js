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

export const pageBreakStart = /^ {0,3}(?:\\newpage|\{\{<[ \t]*pagebreak[ \t]*>\}\})[ \t]*(?:\n|$)/;
export const pageBreakLine = /^ {0,3}(?:\\newpage|\{\{<[ \t]*pagebreak[ \t]*>\}\})[ \t]*$/m;
const pageBreakSyntax = {
  defineNodes:[{ name:'PageBreak', block:true }],
  parseBlock:[{
    name:'PageBreak',
    before:'HorizontalRule',
    endLeaf(_context, line) { return pageBreakLine.test(line.text.slice(line.pos)); },
    parse(context, line) {
      if (!pageBreakLine.test(line.text.slice(line.pos))) return false;
      const from = context.lineStart + line.pos;
      const to = context.lineStart + line.text.length;
      context.nextLine();
      context.addElement(context.elt('PageBreak', from, to));
      return true;
    }
  }]
};

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

class PageBreakPreview extends WidgetType {
  toDOM() {
    const label = document.createElement('span');
    label.className = 'md-page-break';
    label.textContent = 'Page break';
    return label;
  }
  ignoreEvent(event) { return event.type !== 'mousedown'; }
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

function tableAlignments(state, table) {
  const delimiter = table.getChild('TableDelimiter');
  return state.sliceDoc(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, '').split('|').map(value => {
    const marker = value.trim();
    if (!marker.endsWith(':')) return 'left';
    return marker.startsWith(':') ? 'center' : 'right';
  });
}

function tableCellRanges(source) {
  const pipes = [];
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '|' && !escaped) pipes.push(index);
    escaped = char === '\\' && !escaped;
  }
  let from = 0, to = source.length;
  if (pipes.length && !source.slice(0, pipes[0]).trim()) from = pipes.shift() + 1;
  if (pipes.length && !source.slice(pipes.at(-1) + 1).trim()) to = pipes.pop();
  return [...pipes, to].map(end => {
    const range = { from, to:end };
    from = end + 1;
    return range;
  });
}

function tableCells(state, row) {
  const source = state.sliceDoc(row.from, row.to);
  return tableCellRanges(source).map(({ from, to }) => {
    const raw = source.slice(from, to);
    const start = raw.trimStart();
    return { from:row.from + from + raw.length - start.length, text:start.trimEnd().replace(/\\\|/g, '|') };
  });
}

const extendTableAlignment = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || !transaction.isUserEvent('input')) return transaction;
  const { startState, changes, newDoc } = transaction;
  const tree = syntaxTree(startState);
  const headers = new Map();
  changes.iterChangedRanges((from, to) => {
    for (const side of [1, -1]) {
      let node = tree.resolveInner(from, side);
      while (node && node.name !== 'TableHeader') node = node.parent;
      if (node && from >= node.from && to <= node.to) {
        headers.set(node.from, node);
        break;
      }
    }
  });

  const updates = [];
  for (const header of headers.values()) {
    const previous = startState.sliceDoc(header.from, header.to);
    const nextFrom = changes.mapPos(header.from, -1);
    const next = newDoc.sliceString(nextFrom, changes.mapPos(header.to, 1));
    if (next.includes('\n')) continue;
    const oldColumns = tableCellRanges(previous), newColumns = tableCellRanges(next);
    if (newColumns.length <= oldColumns.length) continue;

    const divider = header.parent.getChild('TableDelimiter');
    const dividerFrom = changes.mapPos(divider.from, -1), dividerTo = changes.mapPos(divider.to, 1);
    const source = startState.sliceDoc(divider.from, divider.to);
    if (newDoc.sliceString(dividerFrom, dividerTo) !== source) continue;
    const markers = tableCellRanges(source);
    if (markers.length !== oldColumns.length) continue;

    const beforePipe = /[ \t]\|/.test(source) ? ' ' : '';
    const afterPipe = /\|[ \t]/.test(source) ? ' ' : '';
    const cells = newColumns.map(() => afterPipe + '---' + beforePipe);
    // Keep each existing alignment with its original header text when a column is inserted.
    let index = 0;
    oldColumns.forEach((column, oldIndex) => {
      const text = previous.slice(column.from, column.to);
      const start = header.from + column.from + text.length - text.trimStart().length;
      const position = changes.mapPos(start, 1) - nextFrom;
      const remaining = oldColumns.length - oldIndex;
      while (index + remaining < newColumns.length && newColumns[index].to < position) index++;
      const marker = markers[oldIndex];
      cells[index++] = source.slice(marker.from, marker.to);
    });
    const insert = source.slice(0, markers[0].from) + cells.join('|') + source.slice(markers.at(-1).to);
    updates.push({ from:dividerFrom, to:dividerTo, insert });
  }
  return updates.length ? [transaction, { changes:updates, sequential:true }] : transaction;
});

const tablePositions = new WeakMap();

class TableRowPreview extends WidgetType {
  constructor(state, row, baseUrl, renderCell) {
    super();
    this.from = row.from;
    this.source = state.sliceDoc(row.from, row.to);
    this.kind = row.name;
    this.baseUrl = baseUrl;
    this.renderCell = renderCell;
    this.alignments = this.kind === 'TableDelimiter' ? [] : tableAlignments(state, row.parent);
    this.cells = this.alignments.length ? tableCells(state, row) : [];
  }
  eq(other) {
    return this.from === other.from && this.source === other.source && this.kind === other.kind &&
      this.baseUrl === other.baseUrl && this.alignments.join() === other.alignments.join();
  }
  ignoreEvent(event) {
    return event.type !== 'mousedown' || Boolean(event.metaKey && event.target.closest?.('a[href]'));
  }
  toDOM(view) {
    const row = document.createElement('span');
    tablePositions.set(row, this.from);
    if (this.kind === 'TableDelimiter') {
      row.className = 'md-table-divider-widget';
      row.title = 'Edit table alignment';
    } else {
      row.className = this.kind === 'TableHeader' ? 'md-table-row md-table-header' : 'md-table-row';
      row.style.gridTemplateColumns = `repeat(${this.alignments.length}, minmax(0, 1fr))`;
      this.alignments.forEach((alignment, index) => {
        const cell = document.createElement('span');
        cell.className = 'md-table-cell';
        cell.style.textAlign = alignment;
        const source = this.cells[index];
        tablePositions.set(cell, source?.from ?? this.from + this.source.length);
        if (source?.text) cell.append(this.renderCell(source.text, this.baseUrl));
        row.append(cell);
      });
    }
    row.addEventListener('click', event => {
      if (event.metaKey && event.target.closest?.('a[href]')) return;
      event.preventDefault();
      // Touch interaction can reach click without starting CodeMirror's mouse selection.
      if (!row.isConnected) return;
      const anchor = tablePosition(event) ?? this.from;
      view.dispatch({ selection:{ anchor } });
      view.focus();
    });
    return row;
  }
}

function tablePosition(event) {
  for (const target of event.composedPath()) {
    const position = tablePositions.get(target);
    if (position !== undefined) return position;
  }
}

function tableMouseSelection(view, event) {
  let anchor = tablePosition(event);
  if (event.button !== 0 || anchor === undefined) return null;
  let startingSelection = view.state.selection;
  return {
    get(currentEvent, extend, multiple) {
      const head = currentEvent === event ? anchor :
        tablePosition(currentEvent) ?? view.posAtCoords({ x:currentEvent.clientX, y:currentEvent.clientY }, false) ?? anchor;
      const range = EditorSelection.range(extend ? startingSelection.main.anchor : anchor, head);
      return multiple ? startingSelection.addRange(range) : EditorSelection.create([range]);
    },
    update(update) {
      if (!update.docChanged) return;
      anchor = update.changes.mapPos(anchor);
      startingSelection = startingSelection.map(update.changes);
    }
  };
}

function decorations(view, imageBaseUrl, renderCell) {
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
      if ((name === 'TableHeader' || name === 'TableRow' || name === 'TableDelimiter') && node.parent?.name === 'Table') {
        if (active(from, to)) {
          lineClass(from, 'md-table-source');
        } else {
          if (name === 'TableDelimiter') lineClass(from, 'md-table-divider');
          const widget = new TableRowPreview(state, node, imageBaseUrl, renderCell);
          ranges.push(Decoration.replace({ widget }).range(from, to));
        }
        return false;
      }
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
      if (name === 'PageBreak') hide(from, to, new PageBreakPreview());
    },
    leave({ name, from, to }) {
      if (name === 'Link' && inlineLink?.from === from && inlineLink.to === to) inlineLink = undefined;
    }
  });
  for (const [from, names] of lines) ranges.push(Decoration.line({ class:[...names].join(' ') }).range(from));
  return Decoration.set(ranges, true);
}

function livePreview(getImageBaseUrl, renderCell) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.imageBaseUrl = getImageBaseUrl();
      this.decorations = decorations(view, this.imageBaseUrl, renderCell);
    }
    update(update) {
      const baseUrl = getImageBaseUrl();
      if (baseUrl !== this.imageBaseUrl || update.docChanged || update.selectionSet || update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.imageBaseUrl = baseUrl;
        this.decorations = decorations(update.view, baseUrl, renderCell);
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
  '&':{ backgroundColor:'transparent', color:'var(--text)', fontSize:'17px' },
  '&.cm-focused':{ outline:'none' },
  '.cm-scroller':{ fontFamily:'system-ui,-apple-system,sans-serif', lineHeight:'1.7', overflow:'visible' },
  '.cm-content':{ padding:'0', minHeight:'50vh', caretColor:'var(--accent)' },
  '.cm-line':{ padding:'0', margin:'0', minHeight:'1.7em' },
  '.cm-h1, .md-h1':{ fontSize:'1.65em', fontWeight:'700', lineHeight:'1.4', minHeight:'1.4em' },
  '.md-h2':{ fontSize:'1.4em', fontWeight:'650', lineHeight:'1.45', minHeight:'1.45em' },
  '.md-h3':{ fontSize:'1.2em', fontWeight:'650', minHeight:'1.5em' },
  '.md-h4, .md-h5, .md-h6':{ fontWeight:'650' },
  '.md-bold':{ fontWeight:'700' }, '.md-italic':{ fontStyle:'italic' }, '.md-strike':{ textDecoration:'line-through' },
  '.md-syntax':{ color:'var(--syntax)', fontWeight:'400', textDecoration:'none' },
  '.md-inline-code':{ fontFamily:'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize:'.9em', backgroundColor:'var(--panel)', borderRadius:'3px' },
  '.md-code-line':{ fontFamily:'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize:'.88em', backgroundColor:'var(--panel)', padding:'0 12px' },
  '.md-quote':{ borderLeft:'3px solid var(--quote-border)', paddingLeft:'14px', color:'var(--muted)' },
  '.md-link':{ color:'var(--accent)', textDecoration:'underline', textUnderlineOffset:'3px' },
  '.md-image':{ color:'var(--subtle)' }, '.md-bullet':{ color:'var(--subtle)' },
  '.md-inline-image':{ maxWidth:'100%', height:'auto', verticalAlign:'middle', cursor:'text' },
  '.md-page-break':{ display:'inline-flex', width:'100%', alignItems:'center', gap:'8px', color:'var(--subtle)', fontSize:'12px' },
  '.md-page-break::before, .md-page-break::after':{ content:'""', flex:'1', borderTop:'1px dashed var(--line)' },
  '.md-table-row':{ display:'inline-grid', width:'100%', verticalAlign:'top', cursor:'text' },
  '.md-table-cell':{ minWidth:'0', padding:'4px 10px', borderRight:'1px solid var(--line)', borderBottom:'1px solid var(--line)', whiteSpace:'normal', overflowWrap:'anywhere' },
  '.md-table-cell:first-child':{ borderLeft:'1px solid var(--line)' },
  '.md-table-header .md-table-cell':{ fontWeight:'650', backgroundColor:'var(--panel)', borderTop:'1px solid var(--line)' },
  // CodeMirror paints the selection underneath the editable lines.
  '.cm-line.md-table-source':{ padding:'4px 6px', backgroundColor:'var(--row-highlight)', borderLeft:'1px solid var(--line)', borderRight:'1px solid var(--line)' },
  // The alignment syntax has no rendered row. Its hit area overlays the header seam.
  '.cm-line.md-table-divider':{ position:'relative', height:'0', minHeight:'0', lineHeight:'0', zIndex:'1' },
  '.md-table-divider-widget':{
    position:'absolute', top:'-4px', left:'0', right:'0', height:'8px',
    boxSizing:'border-box', cursor:'text', borderLeft:'1px solid var(--line)', borderRight:'1px solid var(--line)'
  },
  '.md-task':{ accentColor:'var(--accent)', verticalAlign:'middle', margin:'0 4px 0 0' },
  '.md-rule':{ color:'var(--subtle)', borderBottom:'1px solid var(--line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground':{ backgroundColor:'var(--editor-selection) !important' },
  '.cm-cursor':{ borderLeftColor:'var(--accent)' }
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

export function createEditor(parent, source, onChange, openLink, getImageBaseUrl, onSelectionChange, renderCell) {
  const view = new EditorView({
    parent,
    // The supplied ShadowRoot keeps selection and style handling inside the extension.
    root:parent.getRootNode(),
    state:EditorState.create({ doc:source, extensions:[
      markdown({ base:markdownLanguage, extensions:[inlineImageSyntax, pageBreakSyntax] }), history(), drawSelection(),
      EditorView.lineWrapping, livePreview(getImageBaseUrl, renderCell), extendTableAlignment, theme,
      syntaxHighlighting(HighlightStyle.define([{ tag:tags.processingInstruction, color:'var(--syntax)' }])),
      EditorView.contentAttributes.of({ 'aria-label':'Markdown live preview', spellcheck:'true' }),
      EditorView.mouseSelectionStyle.of(tableMouseSelection),
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
