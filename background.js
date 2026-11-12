let database;
let creatingDownloadDocument;

function ensureDownloadDocument() {
  if (!creatingDownloadDocument) {
    creatingDownloadDocument = (async () => {
      const url = chrome.runtime.getURL('download.html');
      const contexts = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
      if (contexts.some(context => context.url === url)) return;
      await chrome.offscreen.createDocument({
        url: 'download.html',
        reasons: ['BLOBS'],
        justification: 'Create local Markdown files for Chrome’s Save As dialog.'
      });
    })().finally(() => { creatingDownloadDocument = undefined; });
  }
  return creatingDownloadDocument;
}

function revokeDownloadUrl(url) {
  return chrome.runtime.sendMessage({ target: 'download-document', type: 'revoke-blob', url });
}

async function startSave(filename, markdown) {
  await ensureDownloadDocument();
  const url = await chrome.runtime.sendMessage({ target: 'download-document', type: 'create-blob', markdown });
  try {
    return await chrome.downloads.download({ url, filename, saveAs: true });
  } catch (error) {
    await revokeDownloadUrl(url);
    throw error;
  }
}

async function saveStatus(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item || item.byExtensionId !== chrome.runtime.id || item.error === 'USER_CANCELED') return { state: 'cancelled' };
  return { state: item.state, path: item.state === 'complete' ? item.filename : undefined };
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (state?.current !== 'complete' && state?.current !== 'interrupted') return;
  chrome.downloads.search({ id }).then(([item]) => {
    if (item?.byExtensionId === chrome.runtime.id && item.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) {
      return revokeDownloadUrl(item.url);
    }
  }).catch(error => console.error('Could not release the Markdown download.', error));
});

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('offline-markdown-editor', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts', { keyPath: 'id' });
        request.result.createObjectStore('history');
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
    });
  }
  return database;
}

function read(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(stores, mode, operation) {
  const db = await openDatabase();
  const transaction = db.transaction(stores, mode);
  const complete = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  const [result] = await Promise.all([
    Promise.resolve().then(() => operation(transaction)),
    complete
  ]);
  return result;
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'start-save':
      return startSave(message.filename, message.markdown);
    case 'save-status':
      return saveStatus(message.id);
    case 'record-open': {
      const url = new URL(sender.url);
      if (!['file:', 'https:', 'http:'].includes(url.protocol) || !/\.md$/i.test(url.pathname)) return;
      url.hash = '';
      return transact('history', 'readwrite', async transaction => {
        const store = transaction.objectStore('history');
        const recent = await read(store.get('recent')) ?? [];
        const entry = { url: url.href, filename: message.filename };
        store.put([entry, ...recent.filter(file => file.url !== entry.url)].slice(0, 5), 'recent');
      });
    }
    case 'list-files':
      return transact(['drafts', 'history'], 'readonly', async transaction => {
        const [drafts, recent] = await Promise.all([
          read(transaction.objectStore('drafts').getAll()),
          read(transaction.objectStore('history').get('recent'))
        ]);
        return {
          drafts: drafts.sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, filename }) => ({ id, filename })),
          recent: recent ?? []
        };
      });
    case 'get-draft':
      return transact('drafts', 'readonly', transaction => read(transaction.objectStore('drafts').get(message.id)));
    case 'save-draft':
      return transact('drafts', 'readwrite', async transaction => {
        const store = transaction.objectStore('drafts');
        const current = message.id ? await read(store.get(message.id)) : undefined;
        if (message.id && !current) return null;
        const draft = {
          id: current && current.revision === message.revision ? current.id : crypto.randomUUID(),
          revision: crypto.randomUUID(),
          filename: message.filename,
          markdown: message.markdown,
          savedPath: message.savedPath,
          updatedAt: Date.now()
        };
        store.put(draft);
        return draft;
      });
    case 'delete-draft':
      return transact('drafts', 'readwrite', async transaction => {
        const store = transaction.objectStore('drafts');
        const current = await read(store.get(message.id));
        if (!current) return true;
        if (message.revision !== undefined && current.revision !== message.revision) return false;
        store.delete(message.id);
        return true;
      });
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type || message.target === 'download-document') return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  const requiresExtensionPage = message.type === 'list-files' || message.type === 'get-draft' ||
    (message.type === 'delete-draft' && message.revision === undefined);
  if (requiresExtensionPage && !extensionPage) return;

  handleMessage(message, sender).then(
    result => respond({ ok: true, result }),
    error => {
      console.error('Could not complete the Markdown request.', error);
      respond({ ok: false });
    }
  );
  return true;
});
