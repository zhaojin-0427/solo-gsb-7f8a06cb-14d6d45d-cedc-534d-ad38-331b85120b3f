// app.js — 前端逻辑：上传、展示核对清单、下载
const form = document.getElementById('impose-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');
const downloadLink = document.getElementById('download-link');

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

  const sheetsPerSignature = new FormData(form).get('sheetsPerSignature');
  const body = new FormData();
  body.append('pdf', file);
  body.append('sheetsPerSignature', sheetsPerSignature);

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/impose', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `拼版失败（HTTP ${resp.status}）。`);
    }
    renderResult(data);
  } catch (err) {
    showError(err.message || '请求失败，请确认服务已启动。');
  } finally {
    loadingBox.hidden = true;
    submitBtn.disabled = false;
  }
});

function renderResult(data) {
  const { plan, pageSizeMm, outputFaceSize, jobId, downloadName, originalName } = data;

  document.getElementById('summary').replaceChildren(
    row('源文件', originalName),
    row('原始页数', `${plan.totalPages} 页`),
    row('每帖页数', `${plan.sheetsPerSignature} 页`),
    row('帖数', `${plan.signatureCount} 帖`),
    row(
      '补白页数',
      plan.totalBlankPages === 0
        ? '0 页（无需补白）'
        : `${plan.totalBlankPages} 页（补在末帖尾部）`
    ),
    row('输出面数', `${plan.outputFaceCount} 面（即 ${plan.outputFaceCount / 2} 张纸，每张含正/背两面）`),
    row(
      '原页尺寸',
      `${pageSizeMm.width} × ${pageSizeMm.height} mm（输出每面宽 ×2，原页不缩放）`
    ),
    row(
      '输出面尺寸',
      `${pageSizeMm.width * 2} × ${pageSizeMm.height} mm（${Math.round(outputFaceSize.width)} × ${Math.round(outputFaceSize.height)} pt）`
    )
  );

  downloadLink.href = `/api/download/${encodeURIComponent(jobId)}`;
  downloadLink.setAttribute('download', downloadName);
  downloadLink.textContent = `下载拼版 PDF（${downloadName}）`;

  const sheetsWrap = document.getElementById('sheets');
  sheetsWrap.textContent = '';

  let faceNumber = 0;
  for (const sig of plan.signatures) {
    const sec = document.createElement('div');
    sec.className = 'signature';

    const title = document.createElement('div');
    title.className = 'signature-title';
    const blankNote =
      sig.blankCount > 0
        ? `｜含 ${sig.blankCount} 个补白空白位（末帖尾部）`
        : '｜无补白';
    title.textContent = `第 ${sig.signatureIndex} 帖`;
    const meta = document.createElement('span');
    meta.className = 'signature-meta';
    meta.textContent = `（原页 ${firstLastOf(sig)}，共 ${sig.realCount} 个原页${blankNote}）`;
    title.appendChild(meta);
    sec.appendChild(title);

    const table = document.createElement('table');
    table.className = 'faces';
    table.innerHTML = `
      <thead>
        <tr><th>输出面号</th><th>纸张 / 面</th><th>左页</th><th>右页</th></tr>
      </thead>
      <tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    for (const place of sig.places) {
      faceNumber += 1;
      const tr = document.createElement('tr');
      tr.className = place.side;
      tr.appendChild(td(String(faceNumber)));
      tr.appendChild(td(place.label, 'side'));
      tr.appendChild(td(cell(place.left)));
      tr.appendChild(td(cell(place.right)));
      tbody.appendChild(tr);
    }
    sec.appendChild(table);
    sheetsWrap.appendChild(sec);
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function firstLastOf(sig) {
  const pages = sig.places
    .flatMap((p) => [p.left.pageNumber, p.right.pageNumber])
    .filter((n) => n !== null);
  return `第 ${Math.min(...pages)}–${Math.max(...pages)} 页`;
}

function cell(slot) {
  const span = document.createElement('span');
  if (slot.pageNumber === null) {
    span.className = 'cell blank';
    span.textContent = `空白（帖内第 ${slot.signaturePosition} 位）`;
  } else {
    span.className = 'cell page';
    span.textContent = `第 ${slot.pageNumber} 页`;
  }
  return span;
}

function td(content, className) {
  const el = document.createElement('td');
  if (className) el.className = className;
  if (typeof content === 'string') el.textContent = content;
  else el.appendChild(content);
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
