async function writeWithSavePicker(filename, markdown, startIn) {
  const handle = await window.showSaveFilePicker({
    id: 'markdown-editor',
    suggestedName: filename,
    types: [{ description:'Markdown', accept:{ 'text/markdown':['.md'] } }],
    ...(startIn ? { startIn } : {})
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(markdown);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return handle;
}
