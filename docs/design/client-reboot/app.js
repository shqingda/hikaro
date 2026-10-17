// Review-only UI: no transport, credentials, file writes or production commands.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let connected = true;
let decision = null;
let toastTimer;
const titles = { conversation: '会话', approvals: '待确认', devices: '设备' };
const captions = { desktop: '桌面工作台 · 会话、变更和执行范围始终在同一视野', mobile: '移动控制器 · 进展、上下文和关键决定，随手可达', architecture: '连接方式 · 本地执行主机是状态与权限的唯一事实来源' };
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function setView(view) {
  $$('.view').forEach((el) => { el.hidden = el.id !== view; });
  $$('[data-view]').forEach((el) => { const active = el.dataset.view === view; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); });
  $('#view-caption').textContent = captions[view];
}
function setPanel(panel) {
  $$('.panel').forEach((el) => { el.hidden = el.id !== `panel-${panel}`; });
  $$('.workspace-nav [data-panel]').forEach((el) => { const active = el.dataset.panel === panel; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#command-dialog').close();
  setView('desktop');
}
function setPhone(panel) {
  $$('.phone-panel').forEach((el) => { el.hidden = el.id !== `phone-${panel}`; });
  $$('.phone nav [data-phone]').forEach((el) => { const active = el.dataset.phone === panel; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#phone-title').textContent = titles[panel];
}
function syncConnection() {
  document.body.classList.toggle('offline', !connected);
  $('.offline-banner').hidden = connected;
  $$('.connection-state').forEach((el) => { el.textContent = connected ? '已连接 · 本机执行' : '已断线 · 显示上次同步内容'; });
  $('#connection').textContent = connected ? '模拟断线' : '模拟重连';
  $('#connection').setAttribute('aria-pressed', String(!connected));
  $$('[data-approve], [data-deny], .send, .phone-composer button').forEach((el) => { el.disabled = !connected; });
}
function decide(approved) {
  if (!connected || decision !== null) return;
  decision = approved;
  $$('.approval').forEach((el) => { el.hidden = true; });
  const message = approved ? '已允许这一次操作。示例检查已完成；没有执行真实命令。' : '已拒绝这一次操作。示例任务已停止，草稿保留。';
  $$('.approval-result').forEach((el) => { el.hidden = false; el.textContent = message; });
  $$('.run-state').forEach((el) => { el.textContent = approved ? '示例检查已完成' : '已拒绝 · 等待下一步'; });
  toast(message);
}
$$('[data-view]').forEach((el) => el.addEventListener('click', () => setView(el.dataset.view)));
$$('[data-panel]').forEach((el) => el.addEventListener('click', () => setPanel(el.dataset.panel)));
$$('[data-phone]').forEach((el) => el.addEventListener('click', () => setPhone(el.dataset.phone)));
$$('[data-command]').forEach((el) => el.addEventListener('click', () => $('#command-dialog').showModal()));
$$('[data-approve]').forEach((el) => el.addEventListener('click', () => decide(true)));
$$('[data-deny]').forEach((el) => el.addEventListener('click', () => decide(false)));
$$('[data-session]').forEach((el) => el.addEventListener('click', () => {
  if (el.dataset.session !== '恢复会话的连续性') {
    toast(`“${el.dataset.session}”仅展示列表状态；本草案交互集中在当前会话。`);
    return;
  }
  setPanel('conversation');
}));
$('#connection').addEventListener('click', () => { connected = !connected; syncConnection(); });
$('#phone-connect').addEventListener('click', () => { connected = !connected; syncConnection(); });
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  $('#theme').setAttribute('aria-label', dark ? '切换浅色外观' : '切换深色外观');
  $$('img').forEach((img) => {
    img.setAttribute('src', img.getAttribute('src').replace(/\/(mark|wordmark)(-on-ink)?\.svg$/, (_, name) => `/${name}${dark ? '-on-ink' : ''}.svg`));
  });
});
$('#pair').addEventListener('click', () => $('#pair-dialog').showModal());
$('#revoke').addEventListener('click', () => { $('#revoke').textContent = '已模拟撤销'; $('#revoke').disabled = true; toast('示例设备已撤销。真实主机未发生任何变更。'); });
$('#reset').addEventListener('click', () => {
  connected = true; decision = null;
  $$('.approval').forEach((el) => { el.hidden = false; });
  $$('.approval-result').forEach((el) => { el.hidden = true; });
  $$('.run-state').forEach((el) => { el.textContent = '等待你的决定'; });
  $('#revoke').textContent = '模拟撤销'; $('#revoke').disabled = false;
  $('#sent-messages').replaceChildren();
  $('.phone-sent').textContent = '';
  syncConnection(); toast('示例状态已重置，输入的草稿保留。');
});
$('.composer').addEventListener('submit', (event) => {
  event.preventDefault(); if (!connected) return;
  const text = $('#desktop-input').value.trim();
  if (!text) { $('#desktop-input').focus(); return; }
  const message = document.createElement('p');
  message.className = 'user-message'; message.textContent = text;
  $('#sent-messages').append(message); $('#desktop-input').value = '';
  const scroller = $('.conversation-scroll'); scroller.scrollTop = scroller.scrollHeight;
  toast('示例消息已显示。未调用模型。');
});
$('.phone-composer').addEventListener('submit', (event) => {
  event.preventDefault(); if (!connected) return;
  const text = $('#phone-input').value.trim();
  if (!text) { $('#phone-input').focus(); return; }
  $('.phone-sent').textContent = `示例已接收：${text}`;
  $('#phone-input').value = '';
});
$('#new-demo').addEventListener('click', () => { $('#command-dialog').close(); setPanel('conversation'); toast('可在输入框试写草稿；完整的新建流程列入交付阶段 D1。'); $('#desktop-input').focus(); });
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#command-dialog').showModal(); }
});
syncConnection();
