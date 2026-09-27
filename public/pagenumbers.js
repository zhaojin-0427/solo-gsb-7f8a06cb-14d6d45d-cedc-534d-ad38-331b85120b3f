// pagenumbers.js（前端）— 上传原稿与页码设置，渲染页脚页码核对报告
const form = document.getElementById('pagenumbers-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const STATUS_LABEL = {
  ok: { text: '相符', cls: 'ok' },
  mismatch: { text: '错号', cls: 'risk' },
  unknown: { text: '无法判断', cls: 'unknown' },
  skipped: { text: '跳过', cls: 'skip' },
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

  const firstPageIndex = Number(document.getElementById('firstPageIndex').value);
  const firstPrintedNumber = Number(
    document.getElementById('firstPrintedNumber').value
  );
  const footerBandMm = Number(document.getElementById('footerBandMm').value);

  if (!Number.isInteger(firstPageIndex) || firstPageIndex < 1) {
    showError('首个带页码的 PDF 页序必须为不小于 1 的整数。');
    return;
  }
  if (!Number.isInteger(firstPrintedNumber) || firstPrintedNumber < 1) {
    showError('该页印刷页码必须为正整数。');
    return;
  }
  if (!Number.isFinite(footerBandMm) || footerBandMm <= 0) {
    showError('页脚带高度必须为大于 0 的数字（毫米）。');
    return;
  }

  const body = new FormData();
  body.append('pdf', file);
  body.append('firstPageIndex', String(firstPageIndex));
  body.append('firstPrintedNumber', String(firstPrintedNumber));
  body.append('footerBandMm', String(footerBandMm));

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/pagenumbers', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `核对失败（HTTP ${resp.status}）。`);
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
    row(
      '核对设置',
      `首个带页码页：第 ${data.firstPageIndex} 页（印刷页码 ${data.firstPrintedNumber}）｜ 页脚带高 ${data.footerBandMm} mm`
    ),
    row(
      '核对范围',
      summary.skippedPages === 0
        ? `全部 ${summary.checkedPages} 页`
        : `第 ${data.firstPageIndex}–${summary.totalPages} 页，共 ${summary.checkedPages} 页（前 ${summary.skippedPages} 页跳过）`
    ),
    row('相符', `${summary.okPages} 页`),
    row(
      '错号',
      summary.mismatchPages === 0 ? '无' : `${summary.mismatchPages} 页`
    ),
    row(
      '无法判断',
      summary.unknownPages === 0
        ? '无'
        : `${summary.unknownPages} 页（无候选或多个候选）`
    )
  );

  const tbody = document.querySelector('#pages-table tbody');
  tbody.textContent = '';
  for (const page of data.pages) {
    tbody.appendChild(renderRow(page));
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRow(page) {
  const status = STATUS_LABEL[page.status];
  const tr = document.createElement('tr');
  if (page.status === 'mismatch') tr.className = 'row-mismatch';
  else if (page.status === 'unknown') tr.className = 'row-unknown';

  tr.appendChild(td(String(page.pageNumber), 'num'));
  tr.appendChild(td(page.extracted === null ? '—' : String(page.extracted), 'num'));
  tr.appendChild(td(page.expected === null ? '—' : String(page.expected), 'num'));

  const resultTd = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  resultTd.appendChild(badge);
  tr.appendChild(resultTd);

  tr.appendChild(td(page.note || '—'));
  return tr;
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
