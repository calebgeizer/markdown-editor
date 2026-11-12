chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'download-document' || sender.tab) return;
  if (message.type === 'create-blob') {
    const blob = new Blob([message.markdown], { type: 'text/markdown;charset=utf-8' });
    respond(URL.createObjectURL(blob));
  } else if (message.type === 'revoke-blob') {
    URL.revokeObjectURL(message.url);
    respond();
  }
});
