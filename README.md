# markdown-editor

A light weight chrome extension that lets you create, view and edit markdown files in browser. Open a markdown file or click the chrome extension icon to get started!

## Install

The extension comes with its browser bundle in `vendor/`. You can install it in Chrome directly from the extracted project folder. Node.js and `npm install` are only needed to rebuild the bundle or run the tests.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, click **Load unpacked**, and select this folder.
3. Open this extension's **Details** and enable **Allow access to file URLs**.
4. Drag a `.md` file into Chrome (or open its `file:///…/document.md` URL). Refresh any already-open Markdown tab.

## Features

- Automatically opens markdown viewer on markdown files
- Autosave Drafts
- View recently opened files
- Live Preview editor
- Centered document zoom and a light/dark toggle that follows your system until you choose a theme.
- Single line breaks stay visible. Use `\newpage` or `{{< pagebreak >}}` on its own line to start a new printed page.
- Markdown tables preview row by row. Click a row or move the caret into it to edit its Markdown.
- Click task checkboxes in Read or Edit mode to update the Markdown.
- Extended syntax includes footnotes, heading IDs, definition lists, emoji shortcodes, highlights, subscripts, superscripts, automatic links, and syntax highlighting for fenced code blocks in Read mode.
- Inline images with `![[image.jpg]]`. Use a path relative, an absolute local path, or an HTTP(S) image URL.
- Print Button with PDF Export
- Save As and download options
- Offline Support

