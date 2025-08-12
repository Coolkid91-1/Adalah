chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "transcriber.html" });
});
