export function matchInlineImage(text) {
  const match = /^!\[\[([^\r\n]*?)\]\]/.exec(text);
  const target = match?.[1].trim();
  if (target) return { raw:match[0], target };
}

export function localFileUrl(path) {
  const normalized = /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replaceAll('\\', '/') : path;
  const prefix = normalized.startsWith('//') ? 'file:' : normalized.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(normalized).replaceAll('#', '%23').replaceAll('?', '%3F');
}

function resolveImage(target, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const localBase = base.protocol === 'file:' || base.protocol === 'chrome-extension:';
    if (localBase && (/^\/(?!\/)/.test(target) || /^[a-z]:[\\/]|^\\\\/i.test(target))) {
      return new URL(localFileUrl(target));
    }
    const url = new URL(target, base);
    if (['http:', 'https:', 'file:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {}
}

export function createInlineImage(target, baseUrl) {
  const url = resolveImage(target, baseUrl);
  if (!url) {
    const label = document.createElement('span');
    label.textContent = `[Image: ${target}]`;
    return label;
  }
  const image = document.createElement('img');
  let name = url.pathname.split('/').pop() || url.hostname;
  try { name = decodeURIComponent(name); } catch {}
  image.className = 'md-inline-image';
  image.alt = name || 'Embedded image';
  image.referrerPolicy = 'no-referrer';
  image.draggable = false;
  image.src = url.href;
  return image;
}
