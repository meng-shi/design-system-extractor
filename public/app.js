const form = document.querySelector('#extract-form');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const submit = form.querySelector('button');
const downloadTemplate = document.querySelector('#download-template');

function tokenValues(group) {
  return Object.entries(group || {}).filter(([, value]) => value && value.$value);
}

function colorCards(group) {
  return tokenValues(group).map(([name, token]) => `
    <article class="swatch">
      <i style="background:${token.$value}"></i>
      <span>${name}</span>
      <code>${token.$value}</code>
    </article>
  `).join('');
}

function render(data) {
  const colors = data.tokens.color || {};
  const fonts = tokenValues(data.tokens.typography)
    .filter(([, token]) => token.$type === 'fontFamily')
    .map(([name, token]) => `<article class="font"><span>${name}</span><strong style="font-family:${token.$value}">${token.$value}</strong></article>`)
    .join('');
  const links = Object.entries(data.downloads).map(([name, href]) => {
    const node = downloadTemplate.content.cloneNode(true);
    const link = node.querySelector('a');
    link.href = href;
    node.querySelector('.file-name').textContent = name;
    return link.outerHTML;
  }).join('');
  const detections = (data.stack?.detections || [])
    .map((detection) => `<li><strong>${detection.name}</strong><span>${detection.category} · ${Math.round(detection.confidence * 100)}% confidence</span></li>`)
    .join('') || '<p>No known framework or animation-library signatures detected.</p>';
  const motion = data.motion || {};
  const motionRows = [
    ['Animated elements', motion.animatedElements || 0],
    ['Durations', (motion.durations || []).map((item) => item.value).join(', ') || 'None observed'],
    ['Easings', (motion.easings || []).map((item) => item.value).join(', ') || 'None observed'],
    ['Keyframes', (motion.keyframes || []).map((item) => item.value).join(', ') || 'None observed'],
  ].map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('');

  results.hidden = false;
  results.innerHTML = `
    <div class="result-heading">
      <div><p class="eyebrow">Extraction complete</p><h2>${data.title || new URL(data.sourceUrl).hostname}</h2></div>
      <p>${data.tokenCount} tokens from ${data.pageUrls.length} page${data.pageUrls.length === 1 ? '' : 's'} · ${data.method || 'rendered'}</p>
    </div>
    <div class="token-grid">
      <section><h3>Brand</h3><div class="swatches">${colorCards(colors.brand)}</div></section>
      <section><h3>Neutrals</h3><div class="swatches">${colorCards(colors.neutral)}</div></section>
      <section><h3>Text</h3><div class="swatches">${colorCards(colors.text)}</div></section>
      <section><h3>Typography</h3><div class="fonts">${fonts || '<p>No dominant family found.</p>'}</div></section>
      <section><h3>Motion system</h3><table class="motion-table">${motionRows}</table></section>
      <section><h3>Built with</h3><ul class="detections">${detections}</ul></section>
    </div>
    <section class="downloads">
      <h3>Take the system with you</h3>
      <a href="${data.zip}" class="download" download><span class="file-name">design-system.zip</span><span>Download all ↓</span></a>
      <div>${links}</div>
    </section>
  `;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  body.pages = Number(body.pages);
  status.textContent = 'Rendering pages and extracting design evidence…';
  results.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Extraction failed.');
    status.textContent = 'Ready to download.';
    render(data);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Extraction failed.';
  } finally {
    submit.disabled = false;
  }
});
