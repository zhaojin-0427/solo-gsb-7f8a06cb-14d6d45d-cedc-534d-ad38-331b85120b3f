// imageresolution.js（前端）— 上传原稿与最低 DPI，渲染位图有效分辨率预检报告
const form = document.getElementById('image-resolution-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const MIN_DPI = 72;
const MAX_DPI = 1200;

const PAGE_STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  risk: { text: '有低分辨率位图', cls: 'risk' },
  'no-image': { text: '无图', cls: 'unknown' },
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

  const minDpi = Number(document.getElementById('minDpi').value);
  if (!Number.isFinite(minDpi) || minDpi < MIN_DPI || minDpi > MAX_DPI) {
    showError(`最低分辨率必须为 ${MIN_DPI}～${MAX_DPI} DPI 之间的数字。`);
    return;
  }

  const body = new FormData();
  body.append('pdf', file);
  body.append('minDpi', String(minDpi));

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/image-resolution', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `预检失败（HTTP ${resp.status}）。`);
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
  const riskPages = data.pages
    .filter((pg) => pg.status === 'risk')
    .map((pg) => pg.pageNumber);

  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row('最低分辨率阈值', `${data.minDpi} DPI`),
    row(
      '检查结论',
      summary.riskPlacements === 0
        ? '未发现低于阈值的位图放置'
        : `${summary.riskPlacements} 处位图放置低于阈值，涉及 ${summary.pagesWithRisk} 页` +
            (riskPages.length ? `（第 ${riskPages.join('、')} 页）` : '')
    ),
    row(
      '有位图绘制的页',
      `${summary.pagesWithImage} 页；共 ${summary.totalPlacements} 处放置（同一图像多次放置逐次计数）`
    ),
    row('无位图绘制的页', summary.pagesWithoutImage === 0 ? '无' : `${summary.pagesWithoutImage} 页（标为「无图」）`),
    row(
      '无法判断',
      summary.pagesUnknown === 0 ? '无' : `${summary.pagesUnknown} 页（绘制指令解析失败）`
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
  meta.textContent =
    `${page.widthMm} × ${page.heightMm} mm ｜ 位图放置 ${page.imageCount} 处` +
    (page.riskCount > 0 ? ` ｜ 风险 ${page.riskCount} 处` : '');
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  if (page.images.length === 0) {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = page.note || '本页无位图绘制。';
    card.appendChild(note);
    return card;
  }

  const table = document.createElement('table');
  table.className = 'fonts imageres';
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>图片尺寸（像素）</th>
        <th>放置尺寸（mm）</th>
        <th>横向 DPI</th>
        <th>纵向 DPI</th>
        <th>有效 DPI</th>
        <th>来源</th>
        <th>判定</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const im of page.images) {
    const tr = document.createElement('tr');
    if (im.risk) tr.className = 'row-mismatch';

    tr.appendChild(td(String(im.index), 'num'));
    tr.appendChild(td(`${im.pixelWidth} × ${im.pixelHeight}`, 'num'));
    tr.appendChild(td(`${im.widthMm} × ${im.heightMm}`, 'num'));

    tr.appendChild(dpiTd(im.dpiX));
    tr.appendChild(dpiTd(im.dpiY));

    const minTd = document.createElement('td');
    minTd.className = 'num min-dpi';
    minTd.textContent = im.minDpi;
    if (im.risk) minTd.classList.add('negative');
    tr.appendChild(minTd);

    tr.appendChild(td(im.inForm ? '表单 XObject 内' : '页面内容'));

    const verdictTd = document.createElement('td');
    const verdict = document.createElement('span');
    if (im.risk) {
      verdict.className = 'badge risk';
      verdict.textContent = '低分辨率';
    } else {
      verdict.className = 'badge ok';
      verdict.textContent = '达标';
    }
    verdictTd.appendChild(verdict);
    tr.appendChild(verdictTd);

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

function dpiTd(value) {
  const el = document.createElement('td');
  el.className = 'num dpi';
  el.textContent = value;
  return el;
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
