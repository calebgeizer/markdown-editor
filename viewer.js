(async () => {
  const isExtensionDocument = location.protocol === 'chrome-extension:' && location.pathname === '/new.html';
  if (!isExtensionDocument && !/\.md$/i.test(location.pathname)) return;

  const draftId = isExtensionDocument ? new URLSearchParams(location.search).get('draft') : null;
  let storedDraft;
  if (draftId) {
    try {
      storedDraft = await requestStorage('get-draft', { id: draftId });
    } catch {
      document.body.textContent = 'Could not open this draft. Try again from the toolbar menu.';
      return;
    }
    if (!storedDraft) {
      document.body.textContent = 'This draft is no longer available.';
      return;
    }
  }

  const source = isExtensionDocument ? storedDraft?.markdown ?? '' :
    document.querySelector('body > pre')?.textContent ?? document.body?.textContent ?? '';
  let filename = storedDraft?.filename ?? 'Untitled.md';
  if (!isExtensionDocument) {
    filename = location.pathname.split('/').pop();
    try { filename = decodeURIComponent(filename); } catch {}
  }
  let savedFilename = filename;
  const sourceUrl = isExtensionDocument ? storedDraft?.sourceUrl : location.href;
  let savedPath = storedDraft?.savedPath;
  let savedAsName = storedDraft?.savedAsName, lastSaveHandle;
  if (location.protocol === 'file:') {
    let path = location.pathname;
    try { path = decodeURIComponent(path); } catch {}
    if (location.hostname) path = `//${location.hostname}${path}`;
    else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1).replaceAll('/', '\\');
    savedPath = path;
  }
  let markdown = source, savedText = source, richEditor = null, editing = false;
  const storageAvailable = Boolean(globalThis.chrome?.runtime?.id);
  let draftWrite, downloadCleanup = false, saveNotice = '';
  let typingTimer, lastEditAt, typingInterval, autosaveBlocked = false;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#faf9f6;color:#242424;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all:initial; font-family:system-ui,-apple-system,sans-serif; color:#242424; }
      * { box-sizing:border-box; } [hidden] { display:none !important; }
      .app { height:100vh; display:flex; flex-direction:column; background:#faf9f6; }
      header { display:flex; align-items:center; gap:16px; padding:12px 24px; border-bottom:1px solid #e5e4dc; background:#faf9f6; }
      .title { display:flex; align-items:center; gap:6px; flex:1; min-width:0; }
      .filename { field-sizing:content; min-width:4ch; max-width:28ch; padding:5px 7px; border:1px solid transparent; border-radius:5px; background:transparent; font:inherit; font-size:13px; color:#5c625a; }
      .draft-label { flex:none; border:1px solid #d8d8d3; border-radius:3px; padding:2px 5px; color:#62645e; font-size:11px; }
      .draft-sync { display:grid; place-items:center; width:20px; flex:none; color:#646a61; }
      .draft-sync .syncing { animation:rotate .9s linear infinite; transform-origin:center; }
      @keyframes rotate { to { transform:rotate(360deg); } }
      @media(prefers-reduced-motion:reduce) { .draft-sync .syncing { animation:none; } }
      .filename:not(:focus) { text-overflow:ellipsis; }
      .filename:hover, .filename:focus { border-color:#d9d9d0; }
      button { display:inline-flex; align-items:center; justify-content:center; font:inherit; font-size:12px; border:0; border-radius:6px; padding:8px 12px; background:transparent; color:#5c625a; cursor:pointer; }
      button:hover { background:#eae9e1; color:#24684d; }
      button:disabled { opacity:.5; cursor:default; }
      button:focus-visible, .filename:focus-visible { outline:2px solid #83bca5; outline-offset:2px; }
      .icon-button { width:34px; height:34px; padding:7px; flex:none; }
      main { flex:1; min-height:0; overflow:auto; }
      .document { width:100%; max-width:840px; margin:0 auto; padding:64px 40px 100px; }
      article { font-family:system-ui,-apple-system,sans-serif; font-size:17px; line-height:1.7; color:#30342e; overflow-wrap:anywhere; }
      article { min-height:50vh; } article > :first-child { margin-top:0; }
      h1,h2,h3,h4,h5,h6 { line-height:1.3; letter-spacing:-.025em; }
      h1 { font-size:2em; } h2 { font-size:1.5em; } a { color:#24684d; }
      pre { overflow:auto; background:#eeede7; padding:16px; border-radius:6px; }
      code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.88em; background:#eeede7; border-radius:3px; padding:2px 4px; }
      pre code { padding:0; }
      blockquote { margin-left:0; padding-left:18px; border-left:3px solid #a2b8a4; color:#686862; }
      table { border-collapse:collapse; display:block; overflow:auto; }
      td,th { border:1px solid #d9d9d0; padding:8px 12px; } img { max-width:100%; }
      .md-inline-image { height:auto; vertical-align:middle; }
      hr { border:0; border-top:1px solid #d9d9d0; margin:24px 0; }
      footer { display:flex; gap:12px; justify-content:space-between; padding:10px 24px; font-size:11px; color:#8a8a80; }
      .save-info { display:grid; gap:3px; min-width:0; }
      .save-location { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .document-info { display:grid; gap:3px; flex:none; align-content:start; text-align:right; }
      .editor { min-height:50vh; }
      @media(max-width:650px) { header { gap:8px; padding:10px 16px; } .document { padding:32px 22px 64px; } footer { padding:9px 16px; } .hint { display:none; } }
      @media print {
        :host { position:static !important; background:#fff !important; color:#000 !important; }
        .app { display:block; height:auto; background:#fff; }
        header, footer, .editor { display:none !important; }
        main { overflow:visible; }
        .document { width:auto; max-width:none; padding:0; margin:0; }
        article, article[hidden] { display:block !important; min-height:0; font-size:11pt; line-height:1.5; }
        article, article * { color:#000 !important; background:transparent !important; }
        article a { text-decoration:underline; }
        h1,h2,h3,h4,h5,h6 { break-after:avoid; }
        pre { overflow:visible; white-space:pre-wrap; padding:0; }
        table { display:table; max-width:100%; }
      }
    </style>
    <div class="app">
      <header>
        <div class="title">
          <input class="filename" type="text" aria-label="File title" title="Rename file" spellcheck="false">
          <span class="draft-sync" role="img">
            <svg class="synced" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18H6a4 4 0 0 1-.6-8A6 6 0 0 1 17 8a5 5 0 0 1 1 10h-1M9 15l2 2 4-4"/></svg>
            <svg class="syncing" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><path d="M20 7v4h-4M4 17v-4h4M4.9 9a7.5 7.5 0 0 1 12.5-3L20 9M4 15l2.6 3a7.5 7.5 0 0 0 12.5-3"/></svg>
            <svg class="sync-error" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><path d="M7 18H6a4 4 0 0 1-.6-8A6 6 0 0 1 17 8a5 5 0 0 1 1 10h-1M12 11v3m0 3h.01"/></svg>
          </span>
          <span class="draft-label" hidden>Draft</span>
        </div>
        <button class="mode" type="button" title="Edit (t)">Edit</button>
        <button class="print icon-button" type="button" aria-label="Print" title="Print">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5M7 17H4a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-3M7 14h10v7H7zM17 12h1"/></svg>
        </button>
        <button class="save icon-button" type="button" aria-label="Save Markdown" title="Save Markdown (⌘/Ctrl+S)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></svg>
        </button>
        <button class="download icon-button" type="button" aria-label="Download Markdown" title="Download to Downloads">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 16v3h14v-3"/></svg>
        </button>
      </header>
      <main><div class="document"><article aria-label="Markdown document" tabindex="-1"></article><div class="editor" hidden></div></div></main>
      <footer>
        <div class="save-info"><span role="status" aria-live="polite"></span><span class="save-location"></span></div>
        <div class="document-info">
          <span class="hint">t edit · Esc read</span>
          <span class="word-count"></span>
        </div>
      </footer>
    </div>`;
  const preview = root.querySelector('article'), editorMount = root.querySelector('.editor');
  const modeButton = root.querySelector('.mode'), status = root.querySelector('[role="status"]');
  const saveLocation = root.querySelector('.save-location');
  const wordCount = root.querySelector('.word-count');
  const wordSegmenter = new Intl.Segmenter(undefined, { granularity:'word' });
  const wordBoundary = /^(?:BLOCKQUOTE|BR|DIV|H[1-6]|LI|P|PRE|TD|TH|TR)$/;
  const saveButton = root.querySelector('.save'), draftLabel = root.querySelector('.draft-label');
  const downloadButton = root.querySelector('.download');
  const sync = root.querySelector('.draft-sync');
  const syncedIcon = sync.querySelector('.synced'), syncingIcon = sync.querySelector('.syncing');
  const syncError = sync.querySelector('.sync-error');
  const titleInput = root.querySelector('.filename');
  let renderedMarkdown, renderedImageBaseUrl, renderTimer;
  let totalWords = 0, selectedWords;
  titleInput.value = filename;

  const embeddedImages = new Map();
  const embedPrefix = crypto.getRandomValues(new Uint32Array(4)).join('-');
  const markdownParser = new marked.Marked({
    gfm:true,
    extensions:[{
      name:'inlineImage',
      level:'inline',
      start(text) { return text.indexOf('![['); },
      tokenizer(text) {
        const match = MarkdownEditor.matchInlineImage(text);
        if (match) return { type:'inlineImage', ...match };
      },
      renderer(token) {
        const id = `${embedPrefix}-${embeddedImages.size}`;
        embeddedImages.set(id, token.target);
        return `<span data-md-embed="${id}"></span>`;
      }
    }]
  });
  function getImageBaseUrl() {
    return sourceUrl ?? (savedPath ? MarkdownEditor.localFileUrl(savedPath) : location.href);
  }

  function sanitize(html) {
    const fragment = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT:true, USE_PROFILES:{ html:true },
      FORBID_TAGS:['style','form','iframe','video','audio','source'],
      FORBID_ATTR:['style','srcset','background','poster']
    });
    fragment.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) {
        const label = document.createElement('span'); label.textContent = `[Image: ${img.alt || src}]`; img.replaceWith(label);
      }
    });
    fragment.querySelectorAll('a').forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
    return fragment;
  }
  function pendingFilename() {
    if (titleInput.value === filename) return filename;
    const name = titleInput.value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    if (!name || /^\.md$/i.test(name)) return filename;
    return /\.md$/i.test(name) ? name : `${name}.md`;
  }
  function hasUnsavedChanges() {
    return markdown !== savedText || pendingFilename() !== savedFilename;
  }
  function updateStatus() {
    const dirty = hasUnsavedChanges();
    const isDraft = storedDraft || dirty || (isExtensionDocument && !savedPath && !savedAsName);
    const syncing = typingTimer !== undefined || Boolean(draftWrite);
    const draftError = dirty && !syncing;
    const syncLabel = syncing ? 'Draft autosave pending' : draftError ? 'Draft has unsaved changes' : storedDraft ? 'Draft saved locally' : 'No unsaved changes';
    document.title = `${dirty ? '• ' : ''}${pendingFilename()}`;
    draftLabel.hidden = !isDraft;
    sync.setAttribute('aria-label', syncLabel);
    sync.title = syncLabel;
    syncedIcon.toggleAttribute('hidden', syncing || draftError);
    syncingIcon.toggleAttribute('hidden', !syncing);
    syncError.toggleAttribute('hidden', !draftError);
    if (saveNotice) status.textContent = saveNotice;
    else if (dirty) status.textContent = 'Unsaved edits';
    else if (storedDraft) status.textContent = 'Draft saved';
    else status.textContent = savedPath || savedAsName ? 'Saved' : 'Save to choose a location';
    saveLocation.textContent = savedPath ?? savedAsName ?? 'No local file saved';
    saveLocation.title = savedPath ?? (savedAsName ? 'Chrome provides only the filename for Save As' : '');
  }
  function commitTitle() {
    filename = pendingFilename();
    titleInput.value = filename;
    updateStatus();
  }
  function countWords(content) {
    const text = [];
    function collect(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text.push(node.data);
        return;
      }
      const separatesWords = wordBoundary.test(node.nodeName);
      if (separatesWords) text.push(' ');
      for (const child of node.childNodes) collect(child);
      if (separatesWords) text.push(' ');
    }
    collect(content);
    let count = 0;
    for (const segment of wordSegmenter.segment(text.join(''))) {
      if (segment.isWordLike) count++;
    }
    return count;
  }
  function formatWordCount(count) {
    return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
  }
  function updateWordCount() {
    const prefix = selectedWords === undefined ? '' : `(${formatWordCount(selectedWords)}) `;
    wordCount.textContent = prefix + formatWordCount(totalWords);
  }
  function setSelectedWords(count) {
    if (count === selectedWords) return;
    selectedWords = count;
    updateWordCount();
  }
  function countSelectedMarkdown(selection) {
    if (!selection.length) {
      setSelectedWords(undefined);
      return;
    }
    let count = 0;
    for (const source of selection) {
      count += countWords(sanitize(markdownParser.parse(source)));
      embeddedImages.clear();
    }
    setSelectedWords(count);
  }
  function countReadingSelection() {
    if (editing) return;
    const selection = root.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (!range || range.collapsed || !range.intersectsNode(preview)) {
      setSelectedWords(undefined);
      return;
    }
    const selected = range.cloneRange();
    if (!preview.contains(selected.startContainer)) selected.setStart(preview, 0);
    if (!preview.contains(selected.endContainer)) selected.setEnd(preview, preview.childNodes.length);
    setSelectedWords(countWords(selected.cloneContents()));
  }
  function renderMarkdown(source, baseUrl, inline = false) {
    embeddedImages.clear();
    const fragment = sanitize(inline ? markdownParser.parseInline(source) : markdownParser.parse(source));
    for (const placeholder of fragment.querySelectorAll('[data-md-embed]')) {
      const target = embeddedImages.get(placeholder.dataset.mdEmbed);
      if (target) placeholder.replaceWith(MarkdownEditor.createInlineImage(target, baseUrl));
    }
    embeddedImages.clear();
    return fragment;
  }
  function render() {
    clearTimeout(renderTimer);
    const baseUrl = getImageBaseUrl();
    if (renderedMarkdown === markdown && renderedImageBaseUrl === baseUrl) return;
    preview.replaceChildren(renderMarkdown(markdown, baseUrl));
    totalWords = countWords(preview);
    updateWordCount();
    renderedMarkdown = markdown;
    renderedImageBaseUrl = baseUrl;
  }
  function printDocument() {
    render();
    window.print();
  }
  function openLink(source) {
    const fragment = sanitize(marked.parseInline(source, { gfm:true }));
    const href = fragment.querySelector('a[href]')?.getAttribute('href');
    if (!href) return;
    let url;
    try { url = new URL(href, document.baseURI); } catch { return; }
    if (['http:', 'https:', 'file:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
  }
  function setEditing(value) {
    if (editing === value) return;
    editing = value; editorMount.hidden = !editing; preview.hidden = editing;
    modeButton.textContent = editing ? 'Read' : 'Edit';
    modeButton.title = editing ? 'Read (Escape)' : 'Edit (t)';
    if (editing) {
      if (!richEditor) {
        richEditor = MarkdownEditor.createEditor(editorMount, markdown, value => {
          markdown = value;
          // Keep a rendered copy ready for Chrome's own Print menu.
          clearTimeout(renderTimer);
          renderTimer = setTimeout(render, 150);
          documentChanged();
        }, openLink, getImageBaseUrl, countSelectedMarkdown, (cell, baseUrl) => renderMarkdown(cell, baseUrl, true));
      }
      richEditor.focus();
      richEditor.requestMeasure();
      countSelectedMarkdown(richEditor.selectedMarkdown());
    } else {
      richEditor?.blur();
      setSelectedWords(undefined);
      render();
    }
  }
  function documentChanged() {
    autosaveBlocked = false;
    saveNotice = '';
    if (storageAvailable) {
      const now = performance.now();
      if (lastEditAt !== undefined) {
        const gap = now - lastEditAt;
        typingInterval = typingInterval === undefined ? gap : typingInterval * 0.75 + gap * 0.25;
      }
      lastEditAt = now;
      const idleDelay = typingInterval === undefined ? 750 : Math.max(350, Math.min(1200, typingInterval * 2.5));
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingTimer = lastEditAt = typingInterval = undefined;
        saveDraft();
        updateStatus();
      }, idleDelay);
    }
    updateStatus();
  }
  function updateDraftUrl() {
    if (!isExtensionDocument) return;
    const url = new URL(location.href);
    if (storedDraft) url.searchParams.set('draft', storedDraft.id);
    else url.searchParams.delete('draft');
    history.replaceState(null, '', url);
  }
  async function persistDraft(snapshot) {
    try {
      storedDraft = await requestStorage('save-draft', {
        ...snapshot,
        savedPath,
        savedAsName,
        sourceUrl,
        id: storedDraft?.id,
        revision: storedDraft?.revision
      });
      if (!downloadCleanup) {
        if (storedDraft) {
          savedFilename = snapshot.filename;
          savedText = snapshot.markdown;
        } else {
          autosaveBlocked = snapshot.markdown === markdown && snapshot.filename === pendingFilename();
          if (autosaveBlocked) saveNotice = 'Draft deleted';
        }
        updateDraftUrl();
      }
    } catch {
      if (!downloadCleanup) saveNotice = 'Could not autosave the draft. Retrying automatically.';
    }
  }
  function saveDraft() {
    if (!storageAvailable || draftWrite || downloadCleanup || autosaveBlocked || !hasUnsavedChanges()) return;
    const snapshot = { filename: pendingFilename(), markdown };
    saveNotice = '';
    draftWrite = persistDraft(snapshot).finally(() => {
      draftWrite = undefined;
      updateStatus();
      if (typingTimer === undefined && (snapshot.markdown !== markdown || snapshot.filename !== pendingFilename())) {
        saveDraft();
      }
    });
    updateStatus();
  }
  async function downloadMarkdown(snapshot) {
    const id = await requestStorage('start-save', snapshot);
    let result = await requestStorage('save-status', { id });
    while (result.state === 'in_progress') {
      await new Promise(resolve => setTimeout(resolve, 500));
      result = await requestStorage('save-status', { id });
    }
    return result;
  }
  async function saveFromInsecurePage(snapshot) {
    const token = crypto.getRandomValues(new Uint32Array(4)).join('-');
    let result;
    const relay = (message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || message?.token !== token) return;
      if (message.type === 'save-picker-file') respond(snapshot);
      if (message.type === 'save-picker-result') {
        result = message.result;
        respond(true);
      }
    };
    chrome.runtime.onMessage.addListener(relay);
    try {
      const tabId = await requestStorage('open-save-picker', { token });
      while (!result) {
        const open = await requestStorage('save-picker-open', { tabId });
        if (!open) return result ?? { state:'cancelled' };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return result;
    } finally {
      chrome.runtime.onMessage.removeListener(relay);
    }
  }
  async function saveWithPicker(snapshot) {
    if (!window.showSaveFilePicker) return saveFromInsecurePage(snapshot);
    lastSaveHandle = await writeWithSavePicker(snapshot.filename, snapshot.markdown, lastSaveHandle);
    return { state:'complete', filename:lastSaveHandle.name };
  }
  async function save(saveAs = true) {
    if (saveButton.disabled) return;
    commitTitle();
    const snapshot = { filename, markdown };
    saveButton.disabled = downloadButton.disabled = true;
    saveNotice = saveAs ? 'Choose a save location…' : 'Downloading…';
    updateStatus();
    try {
      const result = await (saveAs ? saveWithPicker(snapshot) : downloadMarkdown(snapshot));
      if (result.state === 'cancelled') {
        saveNotice = 'Save canceled';
        return;
      }
      if (result.state !== 'complete' || !(saveAs ? result.filename : result.path)) throw new Error('Save did not complete.');

      downloadCleanup = true;
      if (draftWrite) await draftWrite;
      const previousImageBaseUrl = getImageBaseUrl();
      savedPath = result.path;
      savedAsName = saveAs ? result.filename : undefined;
      if (getImageBaseUrl() !== previousImageBaseUrl) {
        richEditor?.refreshImages();
        render();
      }
      savedFilename = saveAs ? result.filename : snapshot.filename;
      savedText = snapshot.markdown;
      if (pendingFilename() === snapshot.filename) {
        filename = savedFilename;
        titleInput.value = filename;
      }
      saveNotice = '';
      if (storedDraft && !hasUnsavedChanges()) {
        try {
          const removed = await requestStorage('delete-draft', { id: storedDraft.id, revision: storedDraft.revision });
          if (!removed) saveNotice = 'File saved · newer draft kept';
          storedDraft = undefined;
        } catch {
          saveNotice = 'File saved · could not remove the draft';
        }
      }
      updateDraftUrl();
    } catch (error) {
      saveNotice = error.name === 'AbortError' ? 'Save canceled' : 'Could not save the file. Try again.';
    } finally {
      const saved = downloadCleanup;
      downloadCleanup = false;
      saveButton.disabled = downloadButton.disabled = false;
      updateStatus();
      if (saved && typingTimer === undefined) saveDraft();
    }
  }
  titleInput.addEventListener('input', documentChanged);
  titleInput.addEventListener('blur', commitTitle);
  titleInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (editing) richEditor.focus();
      else setEditing(true);
      return;
    }
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    if (event.key === 'Escape' && titleInput.value !== filename) {
      titleInput.value = filename;
      documentChanged();
    }
    if (editing) richEditor.focus();
    else preview.focus({ preventScroll:true });
  });
  saveButton.addEventListener('click', () => save());
  downloadButton.addEventListener('click', () => save(false));
  root.querySelector('.print').addEventListener('click', printDocument);
  window.addEventListener('beforeprint', () => {
    // Chromium can reject Trusted Types callbacks while dispatching this event.
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.title = pendingFilename();
  });
  window.addEventListener('afterprint', () => {
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    updateStatus();
  });
  modeButton.addEventListener('click', () => setEditing(!editing));
  document.addEventListener('selectionchange', countReadingSelection);
  window.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      printDocument();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.composedPath().includes(titleInput)) return;
    if (event.key === 'Escape' && editing) { event.preventDefault(); setEditing(false); return; }
    // Do not swallow shortcut letters while typing into the document or dialogs.
    const typing = event.composedPath().some(node => node instanceof HTMLElement &&
      (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)));
    if (typing) return;
    if (event.key === 't') { event.preventDefault(); setEditing(true); }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; }
  });
  document.documentElement.style.cssText = 'margin:0!important;padding:0!important;overflow:hidden!important;';
  document.body.replaceChildren(host); document.body.style.cssText = 'margin:0!important;padding:0!important;';
  const printStyle = document.createElement('style');
  printStyle.textContent = '@page { size:A4; margin:20mm; } @media print { html, body { height:auto!important; background:#fff!important; } }';
  document.head.append(printStyle);
  render();
  updateStatus();
  if (storageAvailable) setInterval(saveDraft, 30000);
  if (isExtensionDocument) {
    setEditing(true);
    if (!storedDraft) {
      titleInput.focus();
      titleInput.setSelectionRange(0, filename.length - '.md'.length);
    }
  } else if (storageAvailable) {
    requestStorage('record-open', { filename }).catch(error => console.error(error));
  }
})();
