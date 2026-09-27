// fonts.js（前端）— 上传原稿，渲染字体嵌入核查报告
const form = document.getElementById('fonts-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const FONT_STATUS_LABEL = {
  embedded: { text: '已嵌入', cls: 'ok' },
  'not-embedded': { text: '未嵌入', cls: 'risk' },
  standard14: { text: '可替代', cls: 'replaceable' },
  type3: { text: '内置字形', cls: 'type3' },
  unknown: { text: '无法判断', cls: 'unknown' },
};

const PAGE_STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  risk: { text: '有未嵌入字体', cls: 'risk' },
  unknown: { text: '无法判断', cls: 'unknown' },
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  resultBox.hidden = true;

  const fileInput = document.getElementById('pdf');
  const file = fileInput.files[0];
  if (!file) {
    showError('请先选择一个 PDF 文件。');
    return;
  }

  const body = new FormData();
  body.append('pdf', file);

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/fonts', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `核查失败（HTTP ${resp.status}）。`);
    }
    renderReport(data);
  } catch (err) {
    showError(err.message || '请求失败，请确认服务已启动。');
  } finally {
    loadingBox.hidden = true;
    submitBtn.disabled = false;
  }
});

function renderReport(data) {
  const { summary } = data;
  const unembeddedPages = data.pages
    .filter((pg) => pg.status === 'risk')
    .map((pg) => pg.pageNumber);

  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row('字体引用', `共 ${summary.totalFontRefs} 处（按资源引用计，同一字体被多处引用时重复计数）`),
    row(
      '检查结论',
      summary.pagesWithUnembedded === 0
        ? '未发现未嵌入字体'
        : `${summary.pagesWithUnembedded} 页存在未嵌入字体（第 ${unembeddedPages.join('、')} 页），共 ${summary.notEmbedded} 处`
    ),
    row(
      '已嵌入',
      `${summary.embedded} 处`
    ),
    row(
      '可替代（标准 14 未嵌入）',
      summary.standard14 === 0
        ? '无'
        : `${summary.standard14} 处，涉及 ${summary.pagesWithStandard14} 页`
    ),
    row('内置字形（Type3）', summary.type3 === 0 ? '无' : `${summary.type3} 处`),
    row(
      '无法判断',
      summary.unknown === 0 && summary.pagesWithUnknown === 0
        ? '无'
        : `${summary.unknown} 处字体引用无法判断（字体字典损坏或类型无法识别），涉及 ${summary.pagesWithUnknown} 页`
    )
  );

  const pagesWrap = document.getElementById('pages');
  pagesWrap.textContent = '';
  for (const page of data.pages) {
    pagesWrap.appendChild(renderPage(page));
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPage(page) {
  const status = PAGE_STATUS_LABEL[page.status];
  const card = document.createElement('div');
  card.className = `card page-card ${status.cls}`;

  const head = document.createElement('div');
  head.className = 'page-head';

  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = `第 ${page.pageNumber} 页`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'page-meta';
  meta.textContent = `字体引用 ${page.fonts.length} 处`;
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  if (page.fonts.length === 0) {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = page.note || '本页未引用字体资源。';
    card.appendChild(note);
    return card;
  }

  const table = document.createElement('table');
  table.className = 'fonts';
  table.innerHTML = `
    <thead>
      <tr><th>资源名</th><th>BaseFont</th><th>来源</th><th>状态</th><th>说明</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const font of page.fonts) {
    const tr = document.createElement('tr');
    if (font.status === 'not-embedded') tr.className = 'row-mismatch';
    else if (font.status === 'unknown') tr.className = 'row-unknown';

    tr.appendChild(td(`/${font.resourceName}`, 'resname'));
    tr.appendChild(td(font.baseFont || '—', 'basefont'));
    tr.appendChild(td(font.source));

    const statusTd = document.createElement('td');
    const fontStatus = FONT_STATUS_LABEL[font.status];
    const fontBadge = document.createElement('span');
    fontBadge.className = `badge ${fontStatus.cls}`;
    fontBadge.textContent = fontStatus.text;
    statusTd.appendChild(fontBadge);
    tr.appendChild(statusTd);

    tr.appendChild(td(font.note || '—'));
    tbody.appendChild(tr);
  }
  card.appendChild(table);

  if (page.note && page.status !== 'ok') {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = page.note;
    card.appendChild(note);
  }
  return card;
}

function td(text, className) {
  const el = document.createElement('td');
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function row(dtText, ddText) {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = dtText;
  const dd = document.createElement('dd');
  dd.textContent = ddText;
  frag.append(dt, dd);
  return frag;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}
