// ============================================================
// UrbanistAI — Fase 0 + Fase 1 + Fase 2 (paso de cebra)
//
// ARQUITECTURA DE RENDER (dos capas):
//   canvas        → foto + trazos confirmados (drawingCanvas).
//                   Solo se redibuja cuando la escena cambia.
//   preview-canvas → trazo EN CURSO y overlay de la herramienta zebra.
// ============================================================

// ── Referencias al DOM ──────────────────────────────────────
const canvas        = document.getElementById('canvas');
const ctx           = canvas.getContext('2d');
const previewCanvas = document.getElementById('preview-canvas');
const pCtx          = previewCanvas.getContext('2d');
const appEl         = document.getElementById('app');
const fileInput     = document.getElementById('file-input');
const btnUpload     = document.getElementById('btn-upload');
const btnEmpty      = document.getElementById('btn-empty-upload');
const emptyState    = document.getElementById('empty-state');
const colorPicker   = document.getElementById('color-picker');
const widthSlider   = document.getElementById('stroke-width');
const widthVal      = document.getElementById('width-val');
const opacitySlider = document.getElementById('stroke-opacity');
const opacityVal    = document.getElementById('opacity-val');
const btnClear      = document.getElementById('btn-clear');
const btnUndo       = document.getElementById('btn-undo');
const btnRedo       = document.getElementById('btn-redo');
const zebraHint        = document.getElementById('zebra-hint');
const btnZebraConfirm  = document.getElementById('btn-zebra-confirm');
const btnZebraCancel   = document.getElementById('btn-zebra-cancel');
const zebraLengthSlider  = document.getElementById('zebra-length');
const zebraLengthVal     = document.getElementById('zebra-length-val');
const zebraStripeWSlider = document.getElementById('zebra-stripe-w');
const zebraStripeWVal    = document.getElementById('zebra-stripe-w-val');
const zebraGapWSlider    = document.getElementById('zebra-gap-w');
const zebraGapWVal       = document.getElementById('zebra-gap-w-val');
const zebraToneSlider    = document.getElementById('zebra-tone');
const zebraToneVal       = document.getElementById('zebra-tone-val');
const zebraOpacSlider    = document.getElementById('zebra-opacity');
const zebraOpacVal       = document.getElementById('zebra-opacity-val');
const zebraWearSlider    = document.getElementById('zebra-wear');
const zebraWearVal       = document.getElementById('zebra-wear-val');
const toolbarEl          = document.getElementById('toolbar');
const toolbarWrap        = document.getElementById('toolbar-wrap');

// ── Caché de textura de desgaste zebra (generada una sola vez) ─
let wearTexture = null;

// ── Estado de la aplicación ─────────────────────────────────
const state = {
  // Vista (Fase 0)
  image:      null,
  scale:      1,
  panX:       0,
  panY:       0,
  dragging:   false,
  lastX:      0,
  lastY:      0,
  pinchDist:  0,
  pinchMidX:  0,
  pinchMidY:  0,
  isPinching: false,

  // Herramienta y propiedades (Fase 1)
  activeTool:    'pan',
  strokeColor:   '#3b82f6',
  strokeWidth:   5,
  strokeOpacity: 1.0,

  // Historial de trazos
  strokes:       [],
  redoStack:     [],
  currentStroke: null,
  isDrawing:     false,
};

// ── Estado de la herramienta zebra (Fase 2) ─────────────────
const zebraState = {
  points:      [],   // hasta 4 puntos {x,y} en coords de imagen
  draggingIdx: -1,
};

// Dimensiones CSS del canvas
let cssW = 0;
let cssH = 0;

// Canvas offscreen para trazos confirmados (tamaño = imagen en px)
let drawingCanvas = null;
let dCtx          = null;

// ID de requestAnimationFrame pendiente
let rafId = null;

// ============================================================
// INICIALIZACIÓN
// ============================================================

function init() {
  resizeCanvas();
  registerSW();
  window.addEventListener('resize', resizeCanvas);

  btnUpload.addEventListener('click', () => fileInput.click());
  btnEmpty.addEventListener('click',  () => fileInput.click());
  fileInput.addEventListener('change', handleFile);

  document.querySelectorAll('[data-tool]').forEach(btn =>
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool))
  );

  colorPicker.addEventListener('input', () => {
    state.strokeColor = colorPicker.value;
  });
  widthSlider.addEventListener('input', () => {
    state.strokeWidth    = parseInt(widthSlider.value, 10);
    widthVal.textContent = widthSlider.value;
  });
  opacitySlider.addEventListener('input', () => {
    state.strokeOpacity    = parseInt(opacitySlider.value, 10) / 100;
    opacityVal.textContent = opacitySlider.value + '%';
  });

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);
  btnClear.addEventListener('click', clearDrawing);
  btnZebraConfirm.addEventListener('click', confirmZebra);
  btnZebraCancel.addEventListener('click',  cancelZebra);

  [zebraLengthSlider, zebraStripeWSlider, zebraGapWSlider,
   zebraToneSlider, zebraOpacSlider, zebraWearSlider].forEach(s =>
    s.addEventListener('input', () => {
      updateZebraParamDisplays();
      if (zebraState.points.length >= 2) drawZebraPreview();
    })
  );

  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  setupMouse();
  setupTouch();
  toolbarEl.addEventListener('scroll', updateToolbarFades, { passive: true });
  setActiveTool('pan');
}

// ============================================================
// SERVICE WORKER
// ============================================================

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ============================================================
// TAMAÑO DEL CANVAS
// ============================================================

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  cssW = rect.width;
  cssH = rect.height;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  canvas.width          = w;  canvas.height          = h;
  previewCanvas.width   = w;  previewCanvas.height   = h;
  if (state.isDrawing) { state.isDrawing = false; state.currentStroke = null; }
  draw();
  updateToolbarFades();
}

// ============================================================
// CANVAS PRINCIPAL — foto + trazos confirmados
// Solo se llama cuando la ESCENA cambia (no en cada touchmove).
// ============================================================

function scheduleMainRedraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = null; draw(); });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) return;

  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(cssW / 2 + state.panX, cssH / 2 + state.panY);
  ctx.scale(state.scale, state.scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.image, -imgW / 2, -imgH / 2);
  if (drawingCanvas) ctx.drawImage(drawingCanvas, -imgW / 2, -imgH / 2);
  ctx.restore();

  // Al hacer zoom/pan, el overlay zebra debe seguir al asfalto
  if (state.activeTool === 'zebra') drawZebraPreview();
}

// ============================================================
// CANVAS DE PREVIEW — trazo EN CURSO y overlay zebra
// ============================================================

function clearPreview() {
  pCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

// Aplica el mismo transform que draw() para trabajar en coords de imagen.
function applyImgTransform(targetCtx) {
  const dpr  = window.devicePixelRatio || 1;
  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;
  targetCtx.scale(dpr, dpr);
  targetCtx.translate(cssW / 2 + state.panX, cssH / 2 + state.panY);
  targetCtx.scale(state.scale, state.scale);
  targetCtx.translate(-imgW / 2, -imgH / 2);
}

// ── Pincel: añade el segmento nuevo SIN borrar el canvas ────
function appendPenSegment(prevPt, currPt) {
  const s = state.currentStroke;
  pCtx.save();
  applyImgTransform(pCtx);
  pCtx.globalAlpha = s.opacity;
  pCtx.strokeStyle = s.color;
  pCtx.lineWidth   = s.width;
  pCtx.lineCap     = 'round';
  pCtx.lineJoin    = 'round';
  pCtx.beginPath();
  pCtx.moveTo(prevPt.x, prevPt.y);
  pCtx.lineTo(currPt.x, currPt.y);
  pCtx.stroke();
  pCtx.restore();
}

// ── Formas: borra y redibuja la forma entera ────────────────
function updateShapePreview() {
  clearPreview();
  pCtx.save();
  applyImgTransform(pCtx);
  renderStroke(pCtx, state.currentStroke);
  pCtx.restore();
}

// ── Goma: cursor visual en previewCanvas ────────────────────
function drawEraserCursor(imgPt) {
  clearPreview();
  pCtx.save();
  applyImgTransform(pCtx);
  pCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  pCtx.lineWidth   = Math.max(0.5, 1.5 / state.scale);
  pCtx.setLineDash([Math.max(1, 3 / state.scale), Math.max(1, 3 / state.scale)]);
  pCtx.beginPath();
  pCtx.arc(imgPt.x, imgPt.y, state.currentStroke.width / 2, 0, Math.PI * 2);
  pCtx.stroke();
  pCtx.restore();
}

// ── Goma: aplica el borrado DIRECTAMENTE a drawingCanvas ────
function applyEraserSegment(prevPt, currPt) {
  const s = state.currentStroke;
  dCtx.save();
  dCtx.globalCompositeOperation = 'destination-out';
  dCtx.globalAlpha = s.opacity;
  dCtx.lineCap     = 'round';
  dCtx.lineJoin    = 'round';
  dCtx.lineWidth   = s.width;
  dCtx.strokeStyle = 'rgba(0,0,0,1)';
  dCtx.beginPath();
  dCtx.moveTo(prevPt.x, prevPt.y);
  dCtx.lineTo(currPt.x, currPt.y);
  dCtx.stroke();
  dCtx.restore();
}

// ============================================================
// CONVERSIÓN DE COORDENADAS
// ============================================================

function screenToImg(sx, sy) {
  return {
    x: (sx - cssW / 2 - state.panX) / state.scale + state.image.naturalWidth  / 2,
    y: (sy - cssH / 2 - state.panY) / state.scale + state.image.naturalHeight / 2,
  };
}

function imgToScreen(ix, iy) {
  return {
    x: (ix - state.image.naturalWidth  / 2) * state.scale + cssW / 2 + state.panX,
    y: (iy - state.image.naturalHeight / 2) * state.scale + cssH / 2 + state.panY,
  };
}

// ============================================================
// RENDERIZADO DE TRAZOS
// ============================================================

function renderStroke(targetCtx, stroke) {
  if (!stroke || stroke.tool === 'eraser') return;

  targetCtx.save();
  targetCtx.globalAlpha = stroke.opacity;
  targetCtx.strokeStyle = stroke.color;
  targetCtx.lineWidth   = stroke.width;
  targetCtx.lineCap     = 'round';
  targetCtx.lineJoin    = 'round';

  switch (stroke.tool) {
    case 'pen':
      drawSmoothPath(targetCtx, stroke.points);
      break;
    case 'line':
      targetCtx.beginPath();
      targetCtx.moveTo(stroke.x1, stroke.y1);
      targetCtx.lineTo(stroke.x2, stroke.y2);
      targetCtx.stroke();
      break;
    case 'rect': {
      const x = Math.min(stroke.x1, stroke.x2);
      const y = Math.min(stroke.y1, stroke.y2);
      const w = Math.abs(stroke.x2 - stroke.x1);
      const h = Math.abs(stroke.y2 - stroke.y1);
      if (w > 0 || h > 0) targetCtx.strokeRect(x, y, w, h);
      break;
    }
    case 'ellipse': {
      const cx = (stroke.x1 + stroke.x2) / 2;
      const cy = (stroke.y1 + stroke.y2) / 2;
      const rx = Math.abs(stroke.x2 - stroke.x1) / 2;
      const ry = Math.abs(stroke.y2 - stroke.y1) / 2;
      if (rx > 0 && ry > 0) {
        targetCtx.beginPath();
        targetCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        targetCtx.stroke();
      }
      break;
    }
  }
  targetCtx.restore();
}

// Curva suavizada mediante bezier cuadrático (versión definitiva del pincel).
function drawSmoothPath(targetCtx, points) {
  if (!points || points.length === 0) return;
  if (points.length === 1) {
    targetCtx.save();
    targetCtx.fillStyle = targetCtx.strokeStyle;
    targetCtx.beginPath();
    targetCtx.arc(points[0].x, points[0].y, targetCtx.lineWidth / 2, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.restore();
    return;
  }
  targetCtx.beginPath();
  targetCtx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    targetCtx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  const last = points[points.length - 1];
  targetCtx.lineTo(last.x, last.y);
  targetCtx.stroke();
}

// ============================================================
// GESTIÓN DE LA CAPA DE DIBUJO (drawingCanvas offscreen)
// ============================================================

function initDrawingCanvas() {
  drawingCanvas = document.createElement('canvas');
  drawingCanvas.width  = state.image.naturalWidth;
  drawingCanvas.height = state.image.naturalHeight;
  dCtx = drawingCanvas.getContext('2d');
}

// Reconstruye drawingCanvas desde cero (necesario tras undo).
function rebuildDrawingCanvas() {
  dCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  for (const stroke of state.strokes) {
    if (stroke.tool === 'eraser') {
      dCtx.save();
      dCtx.globalCompositeOperation = 'destination-out';
      dCtx.globalAlpha = stroke.opacity;
      dCtx.lineCap     = 'round';
      dCtx.lineJoin    = 'round';
      dCtx.lineWidth   = stroke.width;
      dCtx.strokeStyle = 'rgba(0,0,0,1)';
      drawSmoothPath(dCtx, stroke.points);
      dCtx.restore();
    } else if (stroke.tool === 'zebra') {
      renderZebraStroke(dCtx, stroke);
    } else {
      renderStroke(dCtx, stroke);
    }
  }
}

// ============================================================
// CARGA DE IMAGEN
// ============================================================

function handleFile(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      state.image         = img;
      state.strokes       = [];
      state.redoStack     = [];
      state.currentStroke = null;
      state.isDrawing     = false;
      zebraState.points      = [];
      zebraState.draggingIdx = -1;
      clearPreview();
      initDrawingCanvas();
      fitToCanvas();
      emptyState.classList.add('hidden');
      updateButtons();
      draw();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function fitToCanvas() {
  state.scale = Math.min(cssW / state.image.naturalWidth, cssH / state.image.naturalHeight);
  state.panX  = 0;
  state.panY  = 0;
}

// ============================================================
// GESTIÓN DE HERRAMIENTAS
// ============================================================

// Muestra/oculta los fades laterales según la posición de scroll del toolbar.
// fade-left  → hay contenido oculto a la izquierda
// fade-right → hay contenido oculto a la derecha
// En escritorio (todo cabe) scrollWidth ≈ clientWidth → ningún fade se activa.
function updateToolbarFades() {
  const { scrollLeft, scrollWidth, clientWidth } = toolbarEl;
  toolbarWrap.classList.toggle('fade-left',  scrollLeft > 1);
  toolbarWrap.classList.toggle('fade-right', scrollLeft < scrollWidth - clientWidth - 1);
}

function setActiveTool(tool) {
  if (state.isDrawing) {
    state.isDrawing     = false;
    state.currentStroke = null;
    clearPreview();
  }
  // Salir de zebra: resetear estado y limpiar overlay
  if (state.activeTool === 'zebra' && tool !== 'zebra') {
    zebraState.points      = [];
    zebraState.draggingIdx = -1;
    clearPreview();
  }
  state.activeTool = tool;
  appEl.className  = `tool-${tool}`;
  document.querySelectorAll('[data-tool]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === tool)
  );
  // Entrar en zebra: inicializar instrucciones, displays y textura de desgaste
  if (tool === 'zebra') {
    zebraState.points      = [];
    zebraState.draggingIdx = -1;
    updateZebraParamDisplays();
    updateZebraUI();
    ensureWearTexture();
  }
  // Desplazar la barra para que el botón activo quede visible.
  // inline:'nearest' no mueve si ya es visible → no afecta al escritorio.
  const activeBtn = document.querySelector('[data-tool].active');
  if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

  // Recalcular dimensiones: mostrar/ocultar #zebra-bar y #props-bar
  // cambia la altura disponible del canvas. getBoundingClientRect() fuerza
  // reflow síncrono, así que cssH/cssW quedan correctos inmediatamente.
  resizeCanvas();
}

function updateButtons() {
  const hasImage = !!state.image;
  btnUndo.disabled  = state.strokes.length === 0;
  btnRedo.disabled  = state.redoStack.length === 0;
  btnClear.disabled = state.strokes.length === 0;
  document.querySelectorAll('[data-tool]').forEach(btn => {
    if (btn.dataset.tool !== 'pan') btn.disabled = !hasImage;
  });
}

// ============================================================
// FASE 2 — PASO DE CEBRA EN PERSPECTIVA
// ============================================================

// Interpola de blanco puro (t=0) a blanco sucio/grisáceo cálido (t=100).
function getZebraToneColor(t) {
  const r = Math.round(255 - t * 0.57);  // 255 → 198
  const g = Math.round(255 - t * 0.61);  // 255 → 194
  const b = Math.round(255 - t * 0.69);  // 255 → 186
  return `rgb(${r},${g},${b})`;
}

// Genera una textura de desgaste (elipses aleatorias negras sobre fondo
// transparente). Se usa con destination-out para "comer" partes de las
// franjas. 900 elipses orientadas en horizontal simulan rodadas de tráfico.
function generateWearTexture() {
  const size = 512;
  const tc   = document.createElement('canvas');
  tc.width   = tc.height = size;
  const tCtx = tc.getContext('2d');
  tCtx.fillStyle = '#000';
  for (let i = 0; i < 900; i++) {
    const x     = Math.random() * size;
    const y     = Math.random() * size;
    const rx    = 2 + Math.random() * 18;
    const ry    = 1 + Math.random() * 6;
    const angle = (Math.random() - 0.5) * 0.4;
    tCtx.save();
    tCtx.globalAlpha = 0.04 + Math.random() * 0.45;
    tCtx.translate(x, y);
    tCtx.rotate(angle);
    tCtx.beginPath();
    tCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    tCtx.fill();
    tCtx.restore();
  }
  return tc;
}

function ensureWearTexture() {
  if (!wearTexture) wearTexture = generateWearTexture();
}

// Calcula la homografía que mapea src → dst (4 pares de puntos).
// Resuelve el sistema 8×8 por eliminación gaussiana con pivote parcial.
// Devuelve H como array de 9 elementos [h0..h7, 1] (h8 = h33 = 1).
function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x: xi, y: yi } = src[i];
    const { x: xp, y: yp } = dst[i];
    A.push([ xi, yi, 1,  0,  0, 0, -xi*xp, -yi*xp ]);  b.push(xp);
    A.push([  0,  0, 0, xi, yi, 1, -xi*yp, -yi*yp ]);   b.push(yp);
  }
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) return null;   // quad degenerado
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
    }
  }
  const h = M.map((row, i) => row[n] / row[i]);
  return [...h, 1];   // h[8] = h33 = 1
}

// Proyecta el punto (x, y) del espacio fuente al espacio destino con H.
function applyH(H, x, y) {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x + H[1]*y + H[2]) / w, y: (H[3]*x + H[4]*y + H[5]) / w };
}

// Devuelve el índice del punto más cercano al toque dentro de 32 px en pantalla.
// Usa distancia mínima (no "primero dentro del radio") para evitar ambigüedades
// cuando dos puntos están cerca entre sí.
function hitTestZebraPoint(sx, sy) {
  const R2 = 32 * 32;
  let bestIdx = -1;
  let bestD2  = R2 + 1;
  for (let i = 0; i < zebraState.points.length; i++) {
    const sp = imgToScreen(zebraState.points[i].x, zebraState.points[i].y);
    const d2 = (sx - sp.x) ** 2 + (sy - sp.y) ** 2;
    if (d2 <= R2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return bestIdx;
}

// Orden de puntos: 1=lejos-izq, 2=cerca-izq, 3=cerca-der, 4=lejos-der
const ZEBRA_HINTS = [
  'Toca la esquina LEJANA-IZQUIERDA (1/4)',
  'Toca la esquina PRÓXIMA-IZQUIERDA (2/4)',
  'Toca la esquina PRÓXIMA-DERECHA (3/4)',
  'Toca la esquina LEJANA-DERECHA (4/4)',
  'Arrastra cualquier punto para ajustar · ✓ para pintar',
];

function updateZebraUI() {
  const n = zebraState.points.length;
  zebraHint.textContent    = ZEBRA_HINTS[Math.min(n, 4)];
  btnZebraConfirm.disabled = n < 4;
}

// Calcula todos los parámetros geométricos y visuales desde los sliders.
function getZebraParams() {
  const lengthM  = parseFloat(zebraLengthSlider.value);
  const stripeM  = parseFloat(zebraStripeWSlider.value) / 100;
  const gapM     = parseFloat(zebraGapWSlider.value) / 100;
  const period   = stripeM + gapM;
  const tone     = parseInt(zebraToneSlider.value, 10);
  const opacity  = parseInt(zebraOpacSlider.value, 10) / 100;
  const wear     = parseInt(zebraWearSlider.value, 10) / 100;
  return {
    stripes:    Math.max(1, Math.round(lengthM / period)),
    stripeFill: stripeM / period,
    toneColor:  getZebraToneColor(tone),
    tone,
    opacity,
    wear,
  };
}

// Sincroniza los textos de valor de todos los sliders.
function updateZebraParamDisplays() {
  zebraLengthVal.textContent  = zebraLengthSlider.value + ' m';
  zebraStripeWVal.textContent = zebraStripeWSlider.value + ' cm';
  zebraGapWVal.textContent    = zebraGapWSlider.value + ' cm';
  zebraToneVal.textContent    = zebraToneSlider.value;
  zebraOpacVal.textContent    = zebraOpacSlider.value + '%';
  zebraWearVal.textContent    = zebraWearSlider.value + '%';
}

// Dibuja las franjas proyectadas más los handles en previewCanvas.
// Se llama síncrono tras cada cambio de punto y desde draw() al zoom/pan.
function drawZebraPreview() {
  clearPreview();
  if (!state.image) return;
  const pts = zebraState.points;
  if (pts.length === 0) return;

  pCtx.save();
  applyImgTransform(pCtx);

  // ── Franjas proyectadas (cuando ya hay 4 puntos) ─────────
  // Orden de usuario: 0=lejos-izq, 1=cerca-izq, 2=cerca-der, 3=lejos-der
  // Mapeo al rectángulo plano: y=0 ↔ lado próximo (pts[1],pts[2]) — wide
  //                            y=1 ↔ lado lejano  (pts[0],pts[3]) — narrow
  if (pts.length === 4) {
    const H = computeHomography(
      [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
      [pts[1], pts[2], pts[3], pts[0]]
    );
    if (H) {
      const { stripes, stripeFill, toneColor, opacity, wear } = getZebraParams();
      const imgW = state.image.naturalWidth;
      const imgH = state.image.naturalHeight;
      pCtx.globalAlpha = opacity;
      pCtx.fillStyle   = toneColor;
      for (let i = 0; i < stripes; i++) {
        const y0 = i / stripes;
        const y1 = (i + stripeFill) / stripes;
        const c  = [applyH(H,0,y0), applyH(H,1,y0), applyH(H,1,y1), applyH(H,0,y1)];
        pCtx.beginPath();
        pCtx.moveTo(c[0].x, c[0].y);
        for (let j = 1; j < 4; j++) pCtx.lineTo(c[j].x, c[j].y);
        pCtx.closePath();
        pCtx.fill();
        // Desgaste: destination-out dentro del clip de la franja.
        // El path sigue activo tras fill(), clip() lo usa directamente.
        if (wear > 0 && wearTexture) {
          pCtx.save();
          pCtx.clip();
          pCtx.globalCompositeOperation = 'destination-out';
          pCtx.globalAlpha = wear;
          pCtx.drawImage(wearTexture, 0, 0, imgW, imgH);
          pCtx.restore();
        }
      }
      pCtx.globalAlpha = 1;
    }
  }

  // ── Contorno del quad (línea guía amarilla discontinua) ──
  if (pts.length >= 2) {
    pCtx.strokeStyle = 'rgba(250,204,21,0.9)';
    pCtx.lineWidth   = Math.max(0.5, 2 / state.scale);
    pCtx.setLineDash([Math.max(1, 5/state.scale), Math.max(1, 5/state.scale)]);
    pCtx.beginPath();
    pCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) pCtx.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 4) pCtx.closePath();
    pCtx.stroke();
    pCtx.setLineDash([]);
  }

  // ── Handles de control (círculos numerados) ──────────────
  const R        = Math.max(5, 10 / state.scale);
  const fontSize = Math.max(5, 11 / state.scale);
  for (let i = 0; i < pts.length; i++) {
    pCtx.beginPath();
    pCtx.arc(pts[i].x, pts[i].y, R, 0, Math.PI * 2);
    pCtx.fillStyle = i === zebraState.draggingIdx ? '#facc15' : '#3b82f6';
    pCtx.fill();
    pCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    pCtx.lineWidth   = Math.max(0.4, 1.5 / state.scale);
    pCtx.stroke();
    pCtx.fillStyle    = '#fff';
    pCtx.font         = `bold ${fontSize}px sans-serif`;
    pCtx.textAlign    = 'center';
    pCtx.textBaseline = 'middle';
    pCtx.fillText(String(i + 1), pts[i].x, pts[i].y);
  }

  pCtx.restore();
}

// Renderiza las franjas de un stroke zebra sobre targetCtx
// (que debe estar en espacio de imagen, sin transform adicional).
function renderZebraStroke(targetCtx, stroke) {
  const p = stroke.points;   // [lejos-izq, cerca-izq, cerca-der, lejos-der]
  const H = computeHomography(
    [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
    [p[1], p[2], p[3], p[0]]   // y=0 ↔ lado próximo, y=1 ↔ lado lejano
  );
  if (!H) return;
  const toneColor = getZebraToneColor(stroke.tone ?? 15);
  const wear      = stroke.wear ?? 0;
  const imgW      = state.image.naturalWidth;
  const imgH      = state.image.naturalHeight;
  targetCtx.save();
  targetCtx.globalAlpha = stroke.opacity;
  targetCtx.fillStyle   = toneColor;
  for (let i = 0; i < stroke.stripes; i++) {
    const y0 = i / stroke.stripes;
    const y1 = (i + stroke.stripeFill) / stroke.stripes;
    const c  = [applyH(H,0,y0), applyH(H,1,y0), applyH(H,1,y1), applyH(H,0,y1)];
    targetCtx.beginPath();
    targetCtx.moveTo(c[0].x, c[0].y);
    for (let j = 1; j < 4; j++) targetCtx.lineTo(c[j].x, c[j].y);
    targetCtx.closePath();
    targetCtx.fill();
    if (wear > 0 && wearTexture) {
      targetCtx.save();
      targetCtx.clip();
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.globalAlpha = wear;
      targetCtx.drawImage(wearTexture, 0, 0, imgW, imgH);
      targetCtx.restore();
    }
  }
  targetCtx.restore();
}

// Maneja el toque/click en modo zebra.
function handleZebraDown(sx, sy) {
  if (!state.image) return;
  if (zebraState.points.length < 4) {
    zebraState.points.push(screenToImg(sx, sy));
    updateZebraUI();
    drawZebraPreview();
  } else {
    zebraState.draggingIdx = hitTestZebraPoint(sx, sy);
    if (zebraState.draggingIdx >= 0) drawZebraPreview();
  }
}

// Mueve el handle que se está arrastrando.
function handleZebraMove(sx, sy) {
  if (zebraState.draggingIdx < 0) return;
  zebraState.points[zebraState.draggingIdx] = screenToImg(sx, sy);
  drawZebraPreview();
}

// Vuelca las franjas al drawingCanvas y cierra la herramienta.
function confirmZebra() {
  const pts = zebraState.points;
  if (pts.length !== 4 || !state.image) return;

  const { stripes, stripeFill, tone, opacity, wear } = getZebraParams();
  const stroke = {
    tool:      'zebra',
    points:    [...pts],
    stripes,
    stripeFill,
    opacity,
    tone,
    wear,
  };
  renderZebraStroke(dCtx, stroke);
  state.strokes.push(stroke);
  state.redoStack = [];

  zebraState.points      = [];
  zebraState.draggingIdx = -1;
  clearPreview();
  updateButtons();
  draw();
  setActiveTool('pan');
}

// Cancela sin pintar nada.
function cancelZebra() {
  setActiveTool('pan');
}

// ============================================================
// OPERACIONES DE DIBUJO
// ============================================================

function startDrawing(sx, sy) {
  if (!state.image) return;
  const pt   = screenToImg(sx, sy);
  const base = { tool: state.activeTool, color: state.strokeColor,
                 width: state.strokeWidth, opacity: state.strokeOpacity };
  clearPreview();
  state.isDrawing = true;

  if (base.tool === 'pen') {
    state.currentStroke = { ...base, points: [pt] };
    pCtx.save();
    applyImgTransform(pCtx);
    pCtx.fillStyle   = base.color;
    pCtx.globalAlpha = base.opacity;
    pCtx.beginPath();
    pCtx.arc(pt.x, pt.y, base.width / 2, 0, Math.PI * 2);
    pCtx.fill();
    pCtx.restore();

  } else if (base.tool === 'eraser') {
    state.currentStroke = { ...base, points: [pt] };
    dCtx.save();
    dCtx.globalCompositeOperation = 'destination-out';
    dCtx.globalAlpha = base.opacity;
    dCtx.beginPath();
    dCtx.arc(pt.x, pt.y, base.width / 2, 0, Math.PI * 2);
    dCtx.fill();
    dCtx.restore();
    drawEraserCursor(pt);
    scheduleMainRedraw();

  } else {
    state.currentStroke = { ...base, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    updateShapePreview();
  }
}

function continueDrawing(sx, sy) {
  if (!state.isDrawing || !state.currentStroke) return;
  const pt = screenToImg(sx, sy);
  const s  = state.currentStroke;

  switch (s.tool) {
    case 'pen': {
      const prev = s.points[s.points.length - 1];
      s.points.push(pt);
      appendPenSegment(prev, pt);
      break;
    }
    case 'eraser': {
      const prev = s.points[s.points.length - 1];
      s.points.push(pt);
      applyEraserSegment(prev, pt);
      drawEraserCursor(pt);
      scheduleMainRedraw();
      break;
    }
    default:
      s.x2 = pt.x;
      s.y2 = pt.y;
      updateShapePreview();
      break;
  }
}

function finishDrawing() {
  if (!state.isDrawing || !state.currentStroke) return;
  state.isDrawing = false;
  clearPreview();

  const s = state.currentStroke;
  const hasContent =
    (s.points  && s.points.length >= 1) ||
    (s.x1 !== undefined && (s.x1 !== s.x2 || s.y1 !== s.y2));

  if (hasContent) {
    if (s.tool !== 'eraser') renderStroke(dCtx, s);
    state.strokes.push(s);
    state.redoStack = [];
    updateButtons();
  }

  state.currentStroke = null;
  draw();
}

// ============================================================
// UNDO / REDO / CLEAR
// ============================================================

function undo() {
  if (state.strokes.length === 0) return;
  state.redoStack.push(state.strokes.pop());
  rebuildDrawingCanvas();
  updateButtons();
  draw();
}

function redo() {
  if (state.redoStack.length === 0) return;
  const stroke = state.redoStack.pop();
  state.strokes.push(stroke);
  if (stroke.tool === 'eraser') {
    dCtx.save();
    dCtx.globalCompositeOperation = 'destination-out';
    dCtx.globalAlpha = stroke.opacity;
    dCtx.lineCap     = 'round';
    dCtx.lineJoin    = 'round';
    dCtx.lineWidth   = stroke.width;
    dCtx.strokeStyle = 'rgba(0,0,0,1)';
    drawSmoothPath(dCtx, stroke.points);
    dCtx.restore();
  } else if (stroke.tool === 'zebra') {
    renderZebraStroke(dCtx, stroke);
  } else {
    renderStroke(dCtx, stroke);
  }
  updateButtons();
  draw();
}

function clearDrawing() {
  if (state.strokes.length === 0) return;
  state.redoStack = [];
  state.strokes   = [];
  dCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  updateButtons();
  draw();
}

// ============================================================
// ZOOM (Fase 0)
// ============================================================

function applyZoom(factor, cx, cy) {
  const newScale     = Math.max(0.05, Math.min(20, state.scale * factor));
  const actualFactor = newScale / state.scale;
  state.panX  = cx - cssW / 2 - (cx - cssW / 2 - state.panX) * actualFactor;
  state.panY  = cy - cssH / 2 - (cy - cssH / 2 - state.panY) * actualFactor;
  state.scale = newScale;
  scheduleMainRedraw();
}

// ============================================================
// EVENTOS DE RATÓN (PC)
// ============================================================

function setupMouse() {
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!state.image) return;
    const rect = canvas.getBoundingClientRect();
    applyZoom(e.deltaY < 0 ? 1.12 : 0.88, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (!state.image || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    if (state.activeTool === 'pan') {
      state.dragging = true;
      state.lastX    = e.clientX;
      state.lastY    = e.clientY;
    } else if (state.activeTool === 'zebra') {
      handleZebraDown(sx, sy);
    } else {
      startDrawing(sx, sy);
    }
  });

  window.addEventListener('mousemove', e => {
    if (!state.image) return;
    if (state.dragging) {
      state.panX += e.clientX - state.lastX;
      state.panY += e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      scheduleMainRedraw();
    } else if (state.activeTool === 'zebra' && zebraState.draggingIdx >= 0) {
      const rect = canvas.getBoundingClientRect();
      handleZebraMove(e.clientX - rect.left, e.clientY - rect.top);
    } else if (state.isDrawing) {
      const rect = canvas.getBoundingClientRect();
      continueDrawing(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  window.addEventListener('mouseup', () => {
    state.dragging = false;
    if (state.activeTool === 'zebra') {
      zebraState.draggingIdx = -1;
    } else {
      finishDrawing();
    }
  });
}

// ============================================================
// EVENTOS TÁCTILES (Samsung A56 y similares)
// ============================================================

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getTouchMid(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function setupTouch() {
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!state.image) return;

    if (e.touches.length >= 2) {
      // Dos dedos → pinch-zoom, cancelar cualquier operación en curso
      if (state.isDrawing) {
        state.isDrawing     = false;
        state.currentStroke = null;
        clearPreview();
      }
      zebraState.draggingIdx = -1;
      state.dragging   = false;
      state.isPinching = true;
      state.pinchDist  = getTouchDist(e.touches);
      const mid        = getTouchMid(e.touches);
      state.pinchMidX  = mid.x;
      state.pinchMidY  = mid.y;
      return;
    }

    // Un dedo
    state.isPinching = false;
    const rect = canvas.getBoundingClientRect();
    const sx   = e.touches[0].clientX - rect.left;
    const sy   = e.touches[0].clientY - rect.top;

    if (state.activeTool === 'pan') {
      state.dragging = true;
      state.lastX    = e.touches[0].clientX;
      state.lastY    = e.touches[0].clientY;
    } else if (state.activeTool === 'zebra') {
      handleZebraDown(sx, sy);
    } else {
      startDrawing(sx, sy);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!state.image) return;

    if (e.touches.length >= 2 || state.isPinching) {
      if (e.touches.length < 2) return;
      const rect     = canvas.getBoundingClientRect();
      const newDist  = getTouchDist(e.touches);
      const newMid   = getTouchMid(e.touches);
      const newScale = Math.max(0.05, Math.min(20, state.scale * (newDist / state.pinchDist)));
      const actual   = newScale / state.scale;
      const oldCx    = state.pinchMidX - rect.left;
      const oldCy    = state.pinchMidY - rect.top;
      const newCx    = newMid.x - rect.left;
      const newCy    = newMid.y - rect.top;

      state.panX  = newCx - cssW / 2 - (oldCx - cssW / 2 - state.panX) * actual;
      state.panY  = newCy - cssH / 2 - (oldCy - cssH / 2 - state.panY) * actual;
      state.scale = newScale;
      state.pinchDist = newDist;
      state.pinchMidX = newMid.x;
      state.pinchMidY = newMid.y;
      scheduleMainRedraw();
      return;
    }

    // Un dedo
    const rect = canvas.getBoundingClientRect();
    const sx   = e.touches[0].clientX - rect.left;
    const sy   = e.touches[0].clientY - rect.top;

    if (state.dragging) {
      state.panX += e.touches[0].clientX - state.lastX;
      state.panY += e.touches[0].clientY - state.lastY;
      state.lastX = e.touches[0].clientX;
      state.lastY = e.touches[0].clientY;
      scheduleMainRedraw();
    } else if (state.activeTool === 'zebra') {
      if (zebraState.draggingIdx >= 0) handleZebraMove(sx, sy);
    } else {
      continueDrawing(sx, sy);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length === 0) {
      state.dragging   = false;
      state.isPinching = false;
      if (state.activeTool === 'zebra') {
        zebraState.draggingIdx = -1;
      } else {
        finishDrawing();
      }
    } else if (e.touches.length === 1) {
      state.isPinching = false;
      if (state.activeTool === 'pan') {
        state.dragging = true;
        state.lastX    = e.touches[0].clientX;
        state.lastY    = e.touches[0].clientY;
      }
    }
  }, { passive: false });
}

// ============================================================
// ARRANQUE
// ============================================================

document.addEventListener('DOMContentLoaded', init);
