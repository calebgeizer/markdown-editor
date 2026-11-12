const {chromium} = require('playwright');
const fs = require('node:fs'), assert = require('node:assert/strict');
const base=require('node:path').resolve(__dirname,'..');
const source='# Heading\n\nA **bold** paragraph with *italic* and ~~strike~~.\n\n- [ ] Task\n\n```js\n# literal **code**\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com)\n';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{requests.push(route.request().url());return route.fulfill({contentType:'text/html',body:'<pre>'+source.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>'});});
  await page.goto('http://markdown.test/notes.md');
  await page.evaluate(()=>{
    let savedPath;
    window.downloadRequests=0;
    window.showSaveFilePicker=async ({suggestedName})=>{
      if(window.cancelNextSave) throw new DOMException('Canceled','AbortError');
      let content;
      return {name:suggestedName,createWritable:async()=>({
        write:async markdown=>{content=markdown;},
        close:async()=>{window.savedMarkdown=content;}
      })};
    };
    window.requestStorage=async (type,fields)=>{
      if(type==='start-save'){
        window.downloadRequests++;
        const link=document.createElement('a');
        link.href=URL.createObjectURL(new Blob([fields.markdown],{type:'text/markdown'}));
        link.download=fields.filename;
        document.body.append(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(link.href),1000);
        savedPath='/test/'+fields.filename;
        return 1;
      }
      if(type==='save-status')return {state:'complete',path:savedPath};
      throw new Error('Unexpected extension request '+type);
    };
  });
  for(const script of ['vendor/marked.js','vendor/purify.js','vendor/markdown-editor.js','save-picker.js','viewer.js'])await page.addScriptTag({path:base+'/'+script});
  async function download(saveAs=true){
    if(saveAs){
      const count=await page.evaluate(()=>window.downloadRequests);
      await page.getByRole('button',{name:'Save Markdown',exact:true}).click();
      await page.getByRole('status').filter({hasText:/^Saved$/}).waitFor();
      assert.equal(await page.evaluate(()=>window.downloadRequests),count,'Save As must not use Chrome downloads');
      return page.evaluate(()=>window.savedMarkdown);
    }
    const promise=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download Markdown',exact:true}).click();
    const file=await promise;
    return fs.readFileSync(await file.path(),'utf8');
  }
  const title=page.getByRole('textbox',{name:'File title'});
  const editor=page.getByRole('textbox',{name:'Markdown live preview'});
  assert.equal(await page.locator('.filename + .draft-sync + .draft-label').count(),1,
    'the sync icon must sit between the filename and Draft badge');
  for (let attempt=0;attempt<2;attempt++) {
    await title.fill('notes');await title.press('Tab');
    assert.equal(await title.inputValue(),'notes.md');
    assert.equal(await editor.evaluate(element=>element.getRootNode().activeElement===element),true,
      'Tab from the title must focus the editor in either mode');
  }
  assert.equal(await page.locator('.save + .download').count(),1,'Download must be to the right of Save');
  assert.equal(await download(false),source,'quick download must preserve the Markdown source exactly');
  assert.equal(await page.locator('.save-location').innerText(),'/test/notes.md');
  await page.evaluate(()=>{window.cancelNextSave=true;});
  await page.getByRole('button',{name:'Save Markdown',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Save canceled'}).waitFor();
  assert.equal(await page.locator('.save-location').innerText(),'/test/notes.md');
  await page.evaluate(()=>{window.cancelNextSave=false;});
  assert.equal(await download(),source);
  assert.equal(await page.locator('.save-location').innerText(),'notes.md','the direct file picker exposes the filename');
  assert.equal(await page.locator('.md-code-line .md-bold').count(),0,'code must stay literal');
  await page.locator('.md-task').check();assert.equal(await download(),source.replace('- [ ] Task','- [x] Task'));
  await page.locator('.md-task').uncheck();assert.equal(await download(),source);
  await page.locator('.cm-line').filter({hasText:'A bold paragraph'}).click();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('.cm-line').filter({hasText:'A bold paragraph'}).count(),1,'bold markers must hide outside the span on the same line');
  await page.locator('.md-bold').filter({hasText:'bold'}).click();
  assert.equal(await page.locator('.cm-line').filter({hasText:'A **bold** paragraph'}).count(),1,'clicking bold text must reveal the markers');
  assert.equal(await page.locator('.cm-line.md-h1').innerText(),'Heading','inactive heading syntax should hide');
  await page.locator('.cm-line.md-h1').click();await page.keyboard.press('Home');
  assert.equal(await page.locator('.cm-line.md-h1').innerText(),'# Heading','active heading syntax must reveal');
  const headingBox=await page.locator('.cm-line.md-h1').boundingBox();assert.ok(headingBox.height<45,'heading must not create large block spacing');
  await page.keyboard.press('Delete');await page.keyboard.press('Delete');
  assert.equal(await page.locator('.cm-line.md-h1').count(),0,'deleting # must remove heading formatting');
  let expected=source.replace('# Heading','Heading');assert.equal(await download(),expected);
  await page.locator('.cm-line').filter({hasText:'A bold paragraph'}).click();await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');await page.keyboard.press('Delete');
  for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');await page.keyboard.press('Delete');
  expected=expected.replace('**bold**','bold');assert.equal(await download(),expected,'deleting bold syntax must save plain text without normalization');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('# New heading');
  assert.equal(await page.locator('.cm-line.md-h1').innerText(),'# New heading');
  await page.keyboard.press('Enter');await page.keyboard.type('Next line');
  assert.equal(await page.locator('.cm-line').count(),2,'one Enter must be exactly one newline');
  assert.equal(await download(),'# New heading\nNext line');
  assert.equal(await page.locator('.cm-line.md-h1').innerText(),'New heading');
  await page.locator('.cm-line').filter({hasText:'Next line'}).click();await page.keyboard.press('ArrowUp');assert.equal(await page.locator('.cm-line.md-h1').innerText(),'# New heading');
  await page.keyboard.press('ControlOrMeta+z');assert.notEqual(await download(),'# New heading\nNext line','undo must work');
  await editor.click();await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal(await download(),'# New heading\nNext line','redo must work');
  await page.getByRole('button',{name:'Read',exact:true}).focus();
  await page.keyboard.press('v');
  assert.equal(await editor.isVisible(),true,'v must not switch to reading view');
  await editor.focus();await page.keyboard.press('Escape');
  const preview=page.locator('article');
  assert.equal(await preview.locator('h1').innerText(),'New heading');
  assert.equal(await preview.evaluate(element=>element.matches(':focus')),false,'Escape must leave the reading area unfocused');
  await page.keyboard.press('t');await editor.waitFor();assert.match(await editor.innerText(),/New heading/);
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('**bold**');
  await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await page.keyboard.press('ControlOrMeta+b');
  assert.equal(await download(),'bold','bold shortcut must remove existing delimiters without losing selection');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.press('ControlOrMeta+b');
  assert.equal(await download(),'**bold**','bold shortcut must wrap the selected source');
  await editor.focus();await page.keyboard.press('End');
  assert.equal(await editor.innerText(),'**bold**','bold markers must stay visible immediately after the closing marker');
  await page.keyboard.insertText('.');
  assert.equal(await editor.innerText(),'bold.','typing past the bold span must hide the markers');
  assert.equal(await download(),'**bold**.','hiding bold markers must preserve the source');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');
  const linkSource='[**Project**](https://example.com/guide_(start) "Guide")';
  const linkWithoutBoldMarkers=linkSource.replace('**Project**','Project');
  await page.keyboard.insertText(linkSource.slice(0,-1));
  assert.equal(await page.locator('.cm-line').innerText(),linkWithoutBoldMarkers.slice(0,-1),'an incomplete link must show its URL syntax');
  await page.keyboard.insertText(')');
  assert.equal(await page.locator('.cm-line').innerText(),linkWithoutBoldMarkers,'a caret at the closing parenthesis must keep the URL syntax visible');
  await page.keyboard.insertText('.');
  assert.equal(await page.locator('.cm-line').innerText(),'Project.','punctuation after a link must show its preview');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(' and [Notes](notes.md)');
  await page.keyboard.press('Space');
  assert.equal((await page.locator('.cm-line').innerText()).trimEnd(),'Project and Notes');
  for (const [label,url] of [['Project','https://example.com/guide_(start)'],['Notes','http://markdown.test/notes.md']]) {
    const context=page.context();
    await context.route(url,route=>route.fulfill({contentType:'text/plain',body:label}));
    const opening=context.waitForEvent('page');
    await page.locator('.md-link').filter({hasText:label}).click({modifiers:['Meta']});
    const linkedPage=await opening;
    await linkedPage.waitForURL(url);
    assert.equal(await linkedPage.locator('body').innerText(),label);
    assert.equal(await linkedPage.evaluate(()=>window.opener),null);
    await linkedPage.close();
  }
  assert.equal((await page.locator('.cm-line').innerText()).trimEnd(),'Project and Notes','command-click must leave the caret outside the link');
  await page.keyboard.press('ArrowLeft');
  assert.equal((await page.locator('.cm-line').innerText()).trimEnd(),'Project and [Notes](notes.md)','only the link at the caret must reveal its source');
  await page.locator('.md-link').filter({hasText:'Project'}).click();
  assert.equal((await page.locator('.cm-line').innerText()).trimEnd(),linkSource+' and Notes','clicking the label must reveal the whole link for editing');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('# New heading\nNext line');
  await page.keyboard.press('Home');
  if(process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH});
  await page.evaluate(() => {
    const sanitize=DOMPurify.sanitize;
    window.printedHeadings=[];
    window.print=()=>{
      const preview=document.querySelector('body > div').shadowRoot.querySelector('article');
      window.printedHeadings.push(preview.querySelector('h1')?.textContent);
      DOMPurify.sanitize=()=>{ throw new Error('Trusted Types callback unavailable during beforeprint'); };
      window.dispatchEvent(new Event('beforeprint'));
      DOMPurify.sanitize=sanitize;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await page.getByRole('button',{name:'Print',exact:true}).click();
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText('# Latest heading');
  await page.keyboard.press('ControlOrMeta+p');
  assert.deepEqual(await page.evaluate(()=>window.printedHeadings),['New heading','Latest heading'],
    'the current preview must be rendered before the print dialog starts');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText('# Browser menu heading');
  await page.waitForFunction(()=>document.querySelector('body > div').shadowRoot.querySelector('article h1')?.textContent==='Browser menu heading');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('.document').evaluate(e=>e.getBoundingClientRect().width<=390));
  assert.deepEqual(errors,[]);assert.deepEqual(requests,['http://markdown.test/notes.md']);
  const imageUrl='https://images.test/sample.svg';
  const imageFixture='<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="green"/></svg>';
  await page.route(imageUrl,route=>route.fulfill({contentType:'image/svg+xml',body:imageFixture}));
  await editor.click();await page.keyboard.press('ControlOrMeta+a');
  const imageSource='![['+imageUrl+']]';
  await page.keyboard.insertText('Before '+imageSource);
  const inlineImage=editor.locator('img.md-inline-image');
  assert.equal(await editor.innerText(),'Before '+imageSource,'a caret at the closing brackets must keep the image source visible');
  assert.equal(await inlineImage.count(),0);
  await page.keyboard.insertText('x');
  await inlineImage.waitFor();
  await page.keyboard.press('Backspace');
  assert.equal(await inlineImage.count(),0,'returning to the closing brackets must reveal the image source');
  await page.keyboard.press('Enter');
  assert.equal(await inlineImage.evaluate(async image=>{await image.decode();return image.naturalWidth;}),48);
  await inlineImage.click();
  assert.match(await editor.innerText(),/!\[\[https:\/\/images.test\/sample.svg\]\]/,'clicking an image must reveal the editable path');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('article img.md-inline-image').evaluate(async image=>{await image.decode();return image.naturalWidth;}),48);
  await page.keyboard.press('t');await editor.waitFor();
  const arrowResults=[
    ['Left','one top\n|one two\none end','one top\n| two\none end'],
    ['Right','one top\none two|\none end','one top\none|\none end'],
    ['Up','one| top\none two\none end','one| two\none end'],
    ['Down','one top\none two\none| end','one top\none| end']
  ];
  for(const modifiers of ['Alt','Control+Alt','Shift+Alt']){
    for(const [arrow,afterMove,afterSelection] of arrowResults){
      await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText('one top\none two\none end');
      await page.keyboard.press('ArrowUp');await page.keyboard.press('Home');
      for(let index=0;index<3;index++)await page.keyboard.press('ArrowRight');
      await page.keyboard.press(modifiers+'+Arrow'+arrow);
      await page.keyboard.insertText('|');
      assert.equal(await download(),modifiers==='Alt'?afterMove:afterSelection,modifiers+'+Arrow'+arrow+' must use the correct caret movement');
    }
  }
  await editor.click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText('only one line');
  await page.keyboard.press('Home');await page.keyboard.press('Shift+Alt+ArrowUp');
  await page.keyboard.press('End');await page.keyboard.press('Shift+Alt+ArrowDown');
  assert.equal(await download(),'only one line','Shift+Option must not duplicate a line at a document boundary');
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await page.locator('.hint + .word-count').count(),1,'word count must follow the shortcut hint');
  await editor.click();await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('# Title\n\n**bold** [two words](https://example.invalid/path)\n\n| One | Two |\n| --- | --- |\n| Three | Four |\n\nco**de** and `code sample`');
  await page.getByText('12 words',{exact:true}).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+Alt+ArrowLeft');
  await page.getByText('(1 word) 12 words',{exact:true}).waitFor();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByText('(12 words) 12 words',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.word-count').innerText(),'12 words');
  await page.locator('article > p').first().evaluate(paragraph=>paragraph.getRootNode().getSelection().selectAllChildren(paragraph));
  await page.getByText('(3 words) 12 words',{exact:true}).waitFor();
  await page.locator('article').evaluate(article=>article.getRootNode().getSelection().removeAllRanges());
  await page.getByText('12 words',{exact:true}).waitFor();
  await page.keyboard.press('t');await editor.waitFor();await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.getByText('0 words',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Passed: source-preserving edit/save; active-line marker reveal; inline links and Command-click; deletion of existing # and ** formatting; compact heading height; typed headings; single newline; undo/redo; reading/editing toggle; print preparation; mobile layout; no network requests or JS errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
