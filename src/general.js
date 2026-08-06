chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'saveImage') {
    saveToIDB(msg.data).then(() => sendResponse({ ok: true }));
    return true;  
  }
  if (msg.type === 'loadImage') {
    loadFromIDB().then(data => sendResponse({ data }));
    return true;
  }
});