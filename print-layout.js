const referenceSelector = 'a.footnote-reference[href^="#"]';

function blockBreaks(block) {
  const isCode = block.nodeName === 'PRE';
  const breaks = [];
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const match of node.data.matchAll(isCode ? /\n/g : /\s+/g)) {
        breaks.push([node, match.index + match[0].length]);
      }
    } else if (!isCode && node.matches?.('a, sup, sub, code, br, img')) {
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      breaks.push([node.parentNode, index + 1]);
    } else {
      for (const child of node.childNodes) visit(child);
    }
  }
  visit(block);
  return breaks;
}

function splitBlock(block, point) {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(...point);
  const first = block.cloneNode(false);
  first.append(range.cloneContents());
  range.selectNodeContents(block);
  range.setStart(...point);
  const rest = block.cloneNode(false);
  rest.removeAttribute('id');
  rest.append(range.cloneContents());
  return [first, rest];
}

export function paginateFootnotes(preview, root) {
  const source = preview.cloneNode(true);
  const notes = new Map([...source.querySelectorAll('.footnotes .footnote-item')].map(note => [note.id, note]));
  if (!notes.size) return null;
  source.querySelectorAll('.footnotes').forEach(section => section.remove());

  const layout = document.createElement('div');
  layout.className = 'print-layout';
  root.append(layout);
  const placed = new Set();
  let page, body, noteArea, noteList, pageHeight;
  let pageNotes;
  function startPage() {
    if (pageNotes) for (const id of pageNotes) placed.add(id);
    page = document.createElement('article');
    page.className = 'print-page';
    body = document.createElement('div');
    body.className = 'print-page-body';
    noteArea = document.createElement('section');
    noteArea.className = 'footnotes print-page-notes';
    noteArea.setAttribute('aria-label', 'Footnotes');
    noteList = document.createElement('ol');
    noteArea.append(noteList);
    noteArea.hidden = true;
    page.append(body, noteArea);
    layout.append(page);
    pageHeight = page.getBoundingClientRect().height;
    pageNotes = new Set();
  }
  function refreshNotes() {
    const ids = new Set();
    function addReferences(container) {
      for (const link of container.querySelectorAll(referenceSelector)) {
        const id = link.getAttribute('href').slice(1);
        if (notes.has(id) && !placed.has(id)) ids.add(id);
      }
    }
    addReferences(body);
    for (const id of ids) addReferences(notes.get(id));
    noteList.replaceChildren(...[...ids].map(id => notes.get(id)));
    noteArea.hidden = !ids.size;
    pageNotes = ids;
  }
  function fits() {
    refreshNotes();
    return body.getBoundingClientRect().height + noteArea.getBoundingClientRect().height <= pageHeight;
  }
  function fitBlock(block) {
    const breaks = blockBreaks(block);
    let low = 0, high = breaks.length - 1, best = -1;
    while (low <= high) {
      const index = Math.floor((low + high) / 2);
      const [first] = splitBlock(block, breaks[index]);
      body.append(first);
      if (fits()) {
        best = index;
        low = index + 1;
      } else {
        high = index - 1;
      }
      first.remove();
    }
    return best < 0 ? null : splitBlock(block, breaks[best]);
  }

  startPage();
  for (const block of [...source.childNodes]) {
    if (block.matches?.('.page-break')) {
      if (body.hasChildNodes()) startPage();
      continue;
    }
    if (block.nodeType === Node.TEXT_NODE && !block.data.trim()) continue;
    let remaining = block;
    while (remaining) {
      const hadContent = body.hasChildNodes();
      body.append(remaining);
      if (fits()) break;
      remaining.remove();
      const split = remaining.matches?.('p, pre') ? fitBlock(remaining) : null;
      if (split) {
        const [first, rest] = split;
        body.append(first);
        refreshNotes();
        remaining = rest.hasChildNodes() ? rest : null;
        if (remaining) startPage();
      } else if (hadContent) {
        const heading = body.lastElementChild;
        const keepHeading = heading?.matches('h1,h2,h3,h4,h5,h6') && body.firstChild !== heading;
        if (keepHeading) heading.remove();
        refreshNotes();
        startPage();
        if (keepHeading) body.append(heading);
      } else {
        // Allow Chromium to fragment a block that cannot fit on an empty page.
        body.append(remaining);
        refreshNotes();
        break;
      }
    }
  }
  if (!body.hasChildNodes() && layout.childElementCount > 1) page.remove();
  return layout;
}
