// preflight.js（前端）— 上传原稿与边距，渲染文字安全区预检报告
const form = document.getElementById('preflight-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  risk: { text: '有风险', cls: 'risk' },
  'no-text': { text: '无法判断', cls: 'unknown' },
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

  const trimMarginMm = Number(document.getElementById('trimMarginMm').value);
  const bindingMarginMm = Number(document.getElementById('bindingMarginMm').value);
  for (const [label, v] of [
    ['裁切边距', trimMarginMm],
    ['装订边距', bindingMarginMm],
  ]) {
    if (!Number.isFinite(v) || v <= 0) {
      showError(`${label}必须为大于 0 的数字（毫米）。`);
      return;
    }
  }

  const body = new FormData();
  body.append('pdf', file);
  body.append('trimMarginMm', String(trimMarginMm));
  body.append('bindingMarginMm', String(bindingMarginMm));

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/preflight', { method: 'POST', body });
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
  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row('边距设置', `裁切 ${data.trimMarginMm} mm ｜ 装订 ${data.bindingMarginMm} mm`),
    row(
      '检查结论',
      summary.riskItemCount === 0
        ? '未发现文字穿入禁入带'
        : `共 ${summary.riskItemCount} 处文字穿入禁入带，涉及 ${summary.pagesWithRisk} 页`
    ),
    row(
      '无法判断页',
      summary.pagesNoText === 0
        ? '无'
        : `${summary.pagesNoText} 页（无可提取文字，图像文字未纳入检查）`
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
  const status = STATUS_LABEL[page.status];
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
    `${page.widthMm} × ${page.heightMm} mm ｜ 装订边：${page.bindingEdgeName}侧`;
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  if (page.status === 'no-text') {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = page.note;
    card.appendChild(note);
    return card;
  }

  if (page.items.length === 0) {
    const ok = document.createElement('p');
    ok.className = 'page-note';
    ok.textContent = '本页文字均在安全区内。';
    card.appendChild(ok);
    return card;
  }

  const table = document.createElement('table');
  table.className = 'risks';
  table.innerHTML = `
    <thead>
      <tr><th>文字片段</th><th>风险边（实际边距 / 要求边距）</th><th>最小边距</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const item of page.items) {
    const tr = document.createElement('tr');

    const textTd = document.createElement('td');
    textTd.className = 'frag';
    textTd.textContent = truncate(item.text, 40);
    textTd.title = item.text;
    tr.appendChild(textTd);

    const edgesTd = document.createElement('td');
    for (const edge of item.edges) {
      const chip = document.createElement('span');
      chip.className = 'edge-chip';
      chip.textContent =
        `${edge.edgeName}边 ${fmtMm(edge.distanceMm)} / 要求 ${fmtMm(edge.requiredMm)}`;
      edgesTd.appendChild(chip);
    }
    tr.appendChild(edgesTd);

    const minTd = document.createElement('td');
    minTd.className = 'min-dist';
    if (item.minDistanceMm < 0) minTd.classList.add('negative');
    minTd.textContent = fmtMm(item.minDistanceMm);
    tr.appendChild(minTd);

    tbody.appendChild(tr);
  }
  card.appendChild(table);
  return card;
}

function fmtMm(v) {
  return `${v} mm`;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
