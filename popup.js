const status = document.querySelector('[role="status"]');
const newFileUrl = chrome.runtime.getURL('new.html');
let opening = false;

async function openFile(url, button) {
  if (opening) return;
  opening = true;
  button.disabled = true;
  status.hidden = true;
  try {
    await chrome.tabs.create({ url });
    window.close();
  } catch {
    opening = false;
    button.disabled = false;
    status.textContent = 'Could not open the file. Try again.';
    status.hidden = false;
  }
}

function draftTrash(file, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'trash';
  button.setAttribute('aria-label', `Delete draft ${file.filename}`);
  button.title = 'Delete draft';
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg>';
  button.addEventListener('click', async () => {
    button.disabled = true;
    row.firstElementChild.disabled = true;
    status.hidden = true;
    try {
      await requestStorage('delete-draft', { id: file.id });
      const nextRow = row.nextElementSibling ?? row.previousElementSibling;
      const list = row.parentElement;
      row.remove();
      document.getElementById('drafts-empty').hidden = list.childElementCount > 0;
      (nextRow?.firstElementChild ?? document.getElementById('new-file')).focus();
    } catch {
      button.disabled = false;
      row.firstElementChild.disabled = false;
      status.textContent = 'Could not delete the draft. Try again.';
      status.hidden = false;
    }
  });
  return button;
}

function renderFiles(listId, files, fileUrl) {
  const list = document.getElementById(listId);
  document.getElementById(`${listId}-empty`).hidden = files.length > 0;
  for (const file of files) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = file.filename;
    button.title = file.url ?? file.filename;
    button.addEventListener('click', () => openFile(fileUrl(file), button));
    item.append(button);
    if (listId === 'drafts') item.append(draftTrash(file, item));
    list.append(item);
  }
}

document.getElementById('new-file').addEventListener('click', event => openFile(newFileUrl, event.currentTarget));
requestStorage('list-files').then(({ drafts, recent }) => {
  renderFiles('drafts', drafts, draft => `${newFileUrl}?draft=${encodeURIComponent(draft.id)}`);
  renderFiles('recent', recent, file => file.url);
}).catch(() => {
  status.textContent = 'Could not load drafts or recently opened files.';
  status.hidden = false;
});
