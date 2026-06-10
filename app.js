// ============================================================
// UrbanistAI — Fase 0 + Fase 1
//
// ARQUITECTURA DE RENDER (dos capas):
//   canvas        → foto + trazos confirmados (drawingCanvas).
//                   Solo se redibuja cuando la escena cambia:
//                   zoom/pan, commit, undo/redo, carga de imagen.
//   preview-canvas → trazo EN CURSO. Se actualiza SÍNCRONAMENTE
//                   en cada evento de movimiento, sin necesidad de
//                   redibujar la foto de fondo. Esto es clave para
//                   eliminar el lag en móviles de gama media.
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
  strokeWidth:   5,          // px en espacio de imagen (escala con zoom)
  strokeOpacity: 1.0,

  // Historial de trazos
  strokes:       [],
  redoStack:     [],
  currentStroke: null,
  isDrawing:     false,
};

// Dimensiones CSS del canvas (actualizadas en resizeCanvas)
let cssW = 0;
let cssH = 0;

// Canvas offscreen para trazos confirmados (tamaño = imagen en px)
let drawingCanvas = null;
let dCtx          = null;

// ID de requestAnimationFrame pendiente (solo para el canvas principal)
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

  // Atajos teclado (PC)
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  setupMouse();
  setupTouch();
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
  // Cancelar trazo en curso (la orientación puede haber cambiado)
  if (state.isDrawing) { state.isDrawing = false; state.currentStroke = null; }
  draw();
}

// ============================================================
// CANVAS PRINCIPAL — foto + trazos confirmados
// Solo se llama cuando la ESCENA cambia (no en cada touchmove).
// ============================================================

// Encola un redibujado vía RAF (para zoom/pan y goma en tiempo real)
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
  // El trazo en curso se muestra en previewCanvas, no aquí.
}

// ============================================================
// CANVAS DE PREVIEW — solo el trazo en curso
// Actualizado SÍNCRONAMENTE en cada evento de movimiento.
// Al no incluir la foto, es muy barato de redibujar.
// ============================================================

function clearPreview() {
  pCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

// Aplica el mismo transform que draw() para trabajar en coords de imagen.
// Llamar siempre entre save() y restore().
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
// El trazo se acumula en el previewCanvas punto a punto.
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

// ── Formas (línea/rect/elipse): borra el canvas y redibuja ──
// Necesario porque la forma entera cambia en cada evento.
function updateShapePreview() {
  clearPreview();
  pCtx.save();
  applyImgTransform(pCtx);
  renderStroke(pCtx, state.currentStroke);
  pCtx.restore();
}

// ── Goma: cursor visual (círculo) en previewCanvas ──────────
// La goma borra en drawingCanvas síncronamente (applyEraserSegment),
// y el canvas principal se actualiza vía RAF. Este cursor da
// feedback visual inmediato de posición y tamaño.
function drawEraserCursor(imgPt) {
  clearPreview();
  pCtx.save();
  applyImgTransform(pCtx);
  pCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  // lineWidth en coords de imagen para que el cursor sea 1.5px en pantalla
  pCtx.lineWidth   = Math.max(0.5, 1.5 / state.scale);
  pCtx.setLineDash([Math.max(1, 3 / state.scale), Math.max(1, 3 / state.scale)]);
  pCtx.beginPath();
  pCtx.arc(imgPt.x, imgPt.y, state.currentStroke.width / 2, 0, Math.PI * 2);
  pCtx.stroke();
  pCtx.restore();
}

// ── Goma: aplica el borrado DIRECTAMENTE a drawingCanvas ────
// Se llama en cada touchmove; el resultado aparece en el canvas
// principal la siguiente vez que draw() se ejecuta (vía RAF).
function applyEraserSegment(prevPt, currPt) {
  const s = state.currentStroke;
  dCtx.save();
  dCtx.globalCompositeOperation = 'destination-out';
  dCtx.globalAlpha = s.opacity;
  dCtx.lineCap     = 'round';
  dCtx.lineJoin    = 'round';
  dCtx.lineWidth   = s.width;
  dCtx.strokeStyle = 'rgba(0,0,0,1)'; // color irrelevante con destination-out
  dCtx.beginPath();
  dCtx.moveTo(prevPt.x, prevPt.y);
  dCtx.lineTo(currPt.x, currPt.y);
  dCtx.stroke();
  dCtx.restore();
}

// ============================================================
// CONVERSIÓN DE COORDENADAS (pantalla → imagen)
// ============================================================

function screenToImg(sx, sy) {
  return {
    x: (sx - cssW / 2 - state.panX) / state.scale + state.image.naturalWidth  / 2,
    y: (sy - cssH / 2 - state.panY) / state.scale + state.image.naturalHeight / 2,
  };
}

// ============================================================
// RENDERIZADO DE UN TRAZO (sobre drawingCanvas o previewCanvas)
// El contexto debe estar en coordenadas de imagen.
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

// Curva suavizada mediante bezier cuadrático a través de los puntos.
// Se usa al CONFIRMAR el trazo del pincel (la versión definitiva).
// En preview se usan segmentos rectos para mayor velocidad.
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

function setActiveTool(tool) {
  // Cancelar trazo en curso al cambiar de herramienta
  if (state.isDrawing) {
    state.isDrawing     = false;
    state.currentStroke = null;
    clearPreview();
  }
  state.activeTool = tool;
  appEl.className  = `tool-${tool}`;
  document.querySelectorAll('[data-tool]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === tool)
  );
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
    // Dot inicial: visible si el usuario solo toca sin mover
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
    // Borrado del primer punto (cubre el caso de toque sin movimiento)
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
    // line, rect, ellipse: x1/y1 fijo, x2/y2 se actualiza al arrastrar
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
      // Síncrono: solo dibuja el nuevo segmento, no borra ni redibuja la foto
      appendPenSegment(prev, pt);
      break;
    }
    case 'eraser': {
      const prev = s.points[s.points.length - 1];
      s.points.push(pt);
      applyEraserSegment(prev, pt);  // borra en drawingCanvas (síncrono)
      drawEraserCursor(pt);          // cursor en previewCanvas (síncrono)
      scheduleMainRedraw();          // refleja el borrado en canvas principal (RAF)
      break;
    }
    default: // line, rect, ellipse
      s.x2 = pt.x;
      s.y2 = pt.y;
      // Síncrono: limpia previewCanvas y redibuja solo la forma
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
    if (s.tool !== 'eraser') {
      // Vuelca la versión definitiva (con bezier smooth) al drawingCanvas
      renderStroke(dCtx, s);
    }
    // La goma ya fue aplicada incrementalmente en continueDrawing
    state.strokes.push(s);
    state.redoStack = [];
    updateButtons();
  }

  state.currentStroke = null;
  draw(); // síncrono: evita el flash de 1 frame entre clearPreview y el render
}

// ============================================================
// UNDO / REDO / CLEAR
// ============================================================

function undo() {
  if (state.strokes.length === 0) return;
  state.redoStack.push(state.strokes.pop());
  rebuildDrawingCanvas(); // O(n) en trazos, aceptable para Fase 1
  updateButtons();
  draw();
}

function redo() {
  if (state.redoStack.length === 0) return;
  const stroke = state.redoStack.pop();
  state.strokes.push(stroke);
  // Solo aplica el último trazo (más rápido que rebuild completo)
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
    if (state.activeTool === 'pan') {
      state.dragging = true;
      state.lastX    = e.clientX;
      state.lastY    = e.clientY;
    } else {
      startDrawing(e.clientX - rect.left, e.clientY - rect.top);
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
    } else if (state.isDrawing) {
      const rect = canvas.getBoundingClientRect();
      continueDrawing(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  window.addEventListener('mouseup', () => {
    state.dragging = false;
    finishDrawing();
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
  // passive: false en todos para llamar e.preventDefault() y bloquear
  // el scroll/zoom nativo del navegador mientras usamos el canvas.

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!state.image) return;

    if (e.touches.length >= 2) {
      // Dos dedos → cancelar dibujo y activar pinch-zoom
      if (state.isDrawing) {
        state.isDrawing     = false;
        state.currentStroke = null;
        clearPreview();
      }
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
    } else {
      continueDrawing(sx, sy);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length === 0) {
      state.dragging   = false;
      state.isPinching = false;
      finishDrawing();
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
