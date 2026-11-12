let database;

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
  if (!message?.type) return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  const requiresExtensionPage = message.type === 'list-files' || message.type === 'get-draft' ||
    (message.type === 'delete-draft' && message.revision === undefined);
  if (requiresExtensionPage && !extensionPage) return;

  handleMessage(message, sender).then(
    result => respond({ ok: true, result }),
    error => {
      console.error('Could not access Markdown storage.', error);
      respond({ ok: false });
    }
  );
  return true;
});
