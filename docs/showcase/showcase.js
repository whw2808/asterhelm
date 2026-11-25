const screens = {
  'view-chat': {image: './assets/example-chat.webp', alt: '虚构展品索引的示例聊天，显示整理助手的派单卡及回复。'},
  'view-board': {image: './assets/example-board.webp', alt: '示例看板中，节点 A 和节点 B 各有自己的 Agent。'},
  'view-usage': {image: './assets/example-usage.webp', alt: '虚构用量示例。总控今日输入 1,800、输出 360 个 token。累计有一次调用缺少用量，已知至少 9,540 个 token。'},
};
const screen = document.querySelector('#screen');
for (const group of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  function select(selected) {
    for (const tab of tabs) {
      const active = selected === tab;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    if (screens[selected.id]) {
      const view = screens[selected.id];
      screen.src = view.image;
      screen.alt = view.alt;
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const next = {ArrowRight:(index+1)%tabs.length, ArrowLeft:(index+tabs.length-1)%tabs.length, Home:0, End:tabs.length-1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      select(tabs[next]);
    });
  });
}
const dialog = document.querySelector('#image-dialog');
const large = document.querySelector('#full-screen');
document.querySelector('#zoom-screen').addEventListener('click', () => {
  large.src = screen.currentSrc || screen.src;
  large.alt = screen.alt;
  dialog.showModal();
});
document.querySelector('#close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
