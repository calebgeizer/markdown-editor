const params = new URLSearchParams(location.hash.slice(1));
const request = { sourceTabId: Number(params.get('tab')), token: params.get('token') };
const save = document.querySelector('.save');
const cancel = document.querySelector('.cancel');
const status = document.querySelector('[role="status"]');

async function finish(result) {
  let received;
  try {
    received = await requestStorage('save-picker-result', { ...request, result });
  } catch {}
  if (!received && result.state === 'complete') {
    status.textContent = 'File saved. You can close this tab.';
    return;
  }
  window.close();
}

cancel.addEventListener('click', () => finish({ state:'cancelled' }));
requestStorage('save-picker-file', request).then(snapshot => {
  if (!snapshot) throw new Error('Missing save request.');
  document.querySelector('h1').textContent = snapshot.filename;
  save.disabled = false;
  save.focus();
  save.addEventListener('click', async () => {
    save.disabled = cancel.disabled = true;
    status.textContent = '';
    try {
      const handle = await writeWithSavePicker(snapshot.filename, snapshot.markdown);
      await finish({ state:'complete', filename:handle.name });
    } catch (error) {
      if (error.name === 'AbortError') {
        await finish({ state:'cancelled' });
      } else {
        status.textContent = 'Could not save the file. Try again.';
        save.disabled = cancel.disabled = false;
      }
    }
  });
}).catch(() => {
  status.textContent = 'Open Save As again from the editor.';
});
