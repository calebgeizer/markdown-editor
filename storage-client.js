async function requestStorage(type, fields) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error('Markdown storage is unavailable.');
  return response.result;
}
