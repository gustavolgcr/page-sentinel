const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const template = document.getElementById('item-template');
const formError = document.getElementById('form-error');

function send(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...data }).then((res) => {
    if (res && !res.ok) throw new Error(res.error);
    return res;
  });
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleString('en-US');
}

function statusOf(site) {
  if (site.unseen) return ['changed', 'CHANGED!'];
  if (site.status === 'checking') return ['checking', 'checking…'];
  if (!site.active) return ['paused', 'paused'];
  if (site.status === 'error') return ['error', 'error'];
  if (!site.lastCheck) return ['checking', 'waiting'];
  return ['ok', 'no change'];
}

function fillList(ul, lines) {
  ul.replaceChildren(...lines.map((l) => {
    const li = document.createElement('li');
    li.textContent = l;
    return li;
  }));
  ul.hidden = lines.length === 0;
}

function renderSite(site) {
  const node = template.content.firstElementChild.cloneNode(true);
  const [cls, label] = statusOf(site);
  node.classList.toggle('changed', !!site.unseen);
  node.classList.toggle('paused', !site.active);
  node.classList.toggle('checking', site.status === 'checking');

  const link = node.querySelector('.url');
  link.href = site.url;
  link.textContent = site.url.replace(/^https?:\/\//, '');
  link.title = site.url;
  link.addEventListener('click', () => { if (site.unseen) send('ack', { id: site.id }); });

  const status = node.querySelector('.status');
  status.textContent = label;
  status.classList.add(cls);

  node.querySelector('.meta').textContent =
    `Every ${site.intervalMin} min · last check: ${timeAgo(site.lastCheck)}` +
    (site.method === 'tab' ? ' · using a tab' : '');

  if (site.lastChange && (site.lastChange.added.length || site.lastChange.removed.length)) {
    const box = node.querySelector('.change');
    box.hidden = false;
    box.querySelector('.change-title').textContent = `Last change: ${timeAgo(site.lastChange.at)}`;
    fillList(box.querySelector('.added'), site.lastChange.added.map((l) => '+ ' + l));
    fillList(box.querySelector('.removed'), site.lastChange.removed.map((l) => '− ' + l));
  }

  if (site.status === 'error' && site.lastError) {
    const err = node.querySelector('.item-error');
    err.hidden = false;
    err.textContent = site.lastError;
  }

  const ack = node.querySelector('.ack');
  ack.hidden = !site.unseen;
  ack.addEventListener('click', () => send('ack', { id: site.id }));

  const check = node.querySelector('.check');
  check.disabled = site.status === 'checking';
  check.addEventListener('click', () => send('checkNow', { id: site.id }));

  const toggle = node.querySelector('.toggle');
  toggle.textContent = site.active ? 'Pause' : 'Resume';
  toggle.addEventListener('click', () => send('toggle', { id: site.id }));

  const intervalInput = node.querySelector('.interval-input');
  intervalInput.value = site.intervalMin;
  intervalInput.addEventListener('change', () => {
    send('setInterval', { id: site.id, intervalMin: intervalInput.value })
      .catch((e) => alert(e.message));
  });

  node.querySelector('.reset').addEventListener('click', () => send('resetBaseline', { id: site.id }));

  node.querySelector('.remove').addEventListener('click', () => {
    if (confirm(`Stop watching ${site.url}?`)) send('remove', { id: site.id });
  });

  return node;
}

async function render() {
  // Don't redraw while the user is editing an interval.
  if (document.activeElement && document.activeElement.classList.contains('interval-input')) return;
  const { sites = {} } = await chrome.storage.local.get('sites');
  const items = Object.values(sites).sort((a, b) => a.createdAt - b.createdAt);
  listEl.replaceChildren(...items.map(renderSite));
  emptyEl.hidden = items.length > 0;
}

document.getElementById('add-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  const urlInput = document.getElementById('url');
  try {
    await send('add', {
      url: urlInput.value,
      intervalMin: document.getElementById('interval').value,
    });
    urlInput.value = '';
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
  }
});

document.getElementById('test-sound').addEventListener('click', () => send('testSound'));

// Suggest the current tab as the address.
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const input = document.getElementById('url');
  if (tab && /^https?:/.test(tab.url || '') && !input.value) input.value = tab.url;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites) render();
});
setInterval(render, 15000);
render();
