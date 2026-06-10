// ============================================================
// UrbanistAI — Fase 0 + Fase 1
// Canvas · zoom/pan · capa de dibujo con herramientas · undo/redo
// ============================================================

// ── Referencias al DOM ──────────────────────────────────────
const canvas        = document.getElementById('canvas');
const ctx           = canvas.getContext('2d');
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
  // ── Imagen y vista (Fase 0) ──
  image:   null,       // HTMLImageElement cargado
  scale:   1,          // factor de zoom actual
  panX:    0,          // desplazamiento H respecto al centro (px CSS)
  panY:    0,          // desplazamiento V respecto al centro (px CSS)
  dragging: false,     // ¿arrastre activo?
  lastX:   0,
  lastY:   0,
  pinchDist: 0,
  pinchMidX: 0,
  pinchMidY: 0,
  isPinching: false,   // true mientras hay 2 dedos en pantalla

  // ── Herramienta y propiedades (Fase 1) ──
  activeTool:    'pan',
  strokeColor:   '#3b82f6',
  strokeWidth:   5,         // en píxeles de imagen (escala con el zoom)
  strokeOpacity: 1.0,       // 0.0 – 1.0

  // ── Historial de trazos ──
  strokes:        [],       // trazos confirmados
  redoStack:      [],       // trazos deshechos (para redo)
  currentStroke:  null,     // trazo en curso (aún no confirmado)
  isDrawing:      false,    // ¿el usuario está dibujando ahora mismo?
};

// Dimensiones del canvas en CSS-pixels (actualizado en resizeCanvas)
let cssW = 0;
let cssH = 0;

// Canvas offscreen para la capa de dibujo (en píxeles de imagen).
// Se recrea al cargar cada nueva foto.
let drawingCanvas = null;
let dCtx          = null;

// ID de requestAnimationFrame pendiente (para batching de redraws)
let rafId = null;

// ============================================================
// INICIALIZACIÓN
// ============================================================

function init() {
  resizeCanvas();
  registerSW();

  window.addEventListener('resize', resizeCanvas);

  // Botones de cargar foto
  btnUpload.addEventListener('click', () => fileInput.click());
  btnEmpty.addEventListener('click',  () => fileInput.click());
  fileInput.addEventListener('change', handleFile);

  // Selector de herramientas (todos los botones con data-tool)
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });

  // Controles de propiedades
  colorPicker.addEventListener('input', () => {
    state.strokeColor = colorPicker.value;
  });

  widthSlider.addEventListener('input', () => {
    state.strokeWidth = parseInt(widthSlider.value, 10);
    widthVal.textContent = widthSlider.value;
  });

  opacitySlider.addEventListener('input', () => {
    state.strokeOpacity = parseInt(opacitySlider.value, 10) / 100;
    opacityVal.textContent = opacitySlider.value + '%';
  });

  // Acciones
  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);
  btnClear.addEventListener('click', clearDrawing);

  // Atajos de teclado (PC)
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    }
  });

  setupMouse();
  setupTouch();

  // Activar herramienta pan por defecto
  setActiveTool('pan');
}

// ============================================================
// SERVICE WORKER
// ============================================================

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
      console.warn('SW no registrado:', err)
    );
  }
}

// ============================================================
// CANVAS — TAMAÑO Y RENDERIZADO
// ============================================================

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  cssW = rect.width;
  cssH = rect.height;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  scheduleRedraw();
}

// Encola un redibujado en el próximo frame de animación.
// Llamar muchas veces seguidas produce un solo draw() por frame.
function scheduleRedraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    draw();
  });
}

// Renderiza: fondo → foto → capa de dibujo → trazo en curso (preview)
function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) return;

  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;

  ctx.save();

  // Escalar al DPR para nitidez en pantallas HiDPI/OLED
  ctx.scale(dpr, dpr);

  // Centrar en el canvas + aplicar pan y zoom
  ctx.translate(cssW / 2 + state.panX, cssH / 2 + state.panY);
  ctx.scale(state.scale, state.scale);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Foto (centrada en el origen del espacio-mundo)
  ctx.drawImage(state.image, -imgW / 2, -imgH / 2);

  // Capa de dibujo (mismo origen que la foto)
  if (drawingCanvas) {
    ctx.drawImage(drawingCanvas, -imgW / 2, -imgH / 2);
  }

  // Preview del trazo en curso (trasladamos para trabajar en coords de imagen)
  if (state.currentStroke && state.isDrawing) {
    ctx.save();
    ctx.translate(-imgW / 2, -imgH / 2);
    renderStroke(ctx, state.currentStroke, /* isPreview */ true);
    ctx.restore();
  }

  ctx.restore();
}

// ============================================================
// CONVERSIÓN DE COORDENADAS
// ============================================================

// Transforma coordenadas de pantalla (clientX/Y relativas al canvas)
// a coordenadas de imagen (píxeles del naturalWidth × naturalHeight).
function screenToImg(sx, sy) {
  return {
    x: (sx - cssW / 2 - state.panX) / state.scale + state.image.naturalWidth  / 2,
    y: (sy - cssH / 2 - state.panY) / state.scale + state.image.naturalHeight / 2,
  };
}

// ============================================================
// RENDERIZADO DE UN TRAZO
// ============================================================

/**
 * Dibuja un trazo sobre `targetCtx`.
 * El contexto debe estar en coordenadas de imagen (0,0 = esquina sup-izq).
 *
 * @param {CanvasRenderingContext2D} targetCtx
 * @param {object} stroke  - objeto trazo del historial o currentStroke
 * @param {boolean} isPreview - si es true y la herramienta es goma,
 *   muestra solo el indicador circular (no aplica destination-out
 *   para no borrar la foto del canvas principal).
 */
function renderStroke(targetCtx, stroke, isPreview = false) {
  if (!stroke) return;

  // Goma: en preview mostramos un círculo indicador; al confirmar, borra de drawingCanvas
  if (stroke.tool === 'eraser') {
    if (isPreview) {
      // Indicador visual: círculo del tamaño del borrador
      const pts = stroke.points;
      if (!pts || pts.length === 0) return;
      const last = pts[pts.length - 1];
      targetCtx.save();
      targetCtx.strokeStyle = 'rgba(255,255,255,0.75)';
      targetCtx.lineWidth   = 1.5;
      targetCtx.setLineDash([3, 3]);
      targetCtx.beginPath();
      targetCtx.arc(last.x, last.y, stroke.width / 2, 0, Math.PI * 2);
      targetCtx.stroke();
      targetCtx.restore();
      return;
    }
    // Borrar píxeles de la capa de dibujo
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.globalAlpha = stroke.opacity;
    targetCtx.lineCap     = 'round';
    targetCtx.lineJoin    = 'round';
    targetCtx.lineWidth   = stroke.width;
    targetCtx.strokeStyle = 'rgba(0,0,0,1)'; // el color no importa con destination-out
    drawPath(targetCtx, stroke.points);
    targetCtx.restore();
    return;
  }

  // Resto de herramientas
  targetCtx.save();
  targetCtx.globalAlpha = stroke.opacity;
  targetCtx.strokeStyle = stroke.color;
  targetCtx.lineWidth   = stroke.width;
  targetCtx.lineCap     = 'round';
  targetCtx.lineJoin    = 'round';

  switch (stroke.tool) {
    case 'pen':
      drawPath(targetCtx, stroke.points);
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
      if (w > 0 && h > 0) {
        targetCtx.beginPath();
        targetCtx.rect(x, y, w, h);
        targetCtx.stroke();
      }
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

// Traza una polilínea suavizada con curvas cuadráticas a través de los puntos.
// Produce trazos más orgánicos que simples líneas rectas.
function drawPath(targetCtx, points) {
  if (!points || points.length < 2) {
    // Punto único: dibuja un círculo pequeño
    if (points && points.length === 1) {
      targetCtx.beginPath();
      targetCtx.arc(points[0].x, points[0].y, targetCtx.lineWidth / 2, 0, Math.PI * 2);
      targetCtx.fill();
    }
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
// GESTIÓN DE LA CAPA DE DIBUJO (drawingCanvas)
// ============================================================

// Crea el canvas offscreen del tamaño de la imagen.
// Se llama al cargar una nueva foto (borra el dibujo previo).
function initDrawingCanvas() {
  drawingCanvas = document.createElement('canvas');
  drawingCanvas.width  = state.image.naturalWidth;
  drawingCanvas.height = state.image.naturalHeight;
  dCtx = drawingCanvas.getContext('2d');
}

// Reconstruye drawingCanvas desde cero reproduciendo todos los trazos.
// Necesario tras undo (hay que eliminar el último trazo dibujado).
function rebuildDrawingCanvas() {
  dCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  for (const stroke of state.strokes) {
    renderStroke(dCtx, stroke, false);
  }
}

// ============================================================
// CARGA DE IMAGEN (Fase 0)
// ============================================================

function handleFile(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      // Resetear dibujo y historial al cambiar de foto
      state.strokes   = [];
      state.redoStack = [];
      state.currentStroke = null;
      state.isDrawing = false;
      initDrawingCanvas();
      fitToCanvas();
      emptyState.classList.add('hidden');
      updateButtons();
      draw();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // permite volver a elegir la misma foto
}

function fitToCanvas() {
  const sx = cssW / state.image.naturalWidth;
  const sy = cssH / state.image.naturalHeight;
  state.scale = Math.min(sx, sy);
  state.panX  = 0;
  state.panY  = 0;
}

// ============================================================
// HERRAMIENTAS
// ============================================================

function setActiveTool(tool) {
  state.activeTool = tool;

  // Clase en #app: controla cursores y visibilidad de props-bar (via CSS)
  appEl.className = `tool-${tool}`;

  // Resaltar el botón activo
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

// Habilita / deshabilita botones según el estado del historial
function updateButtons() {
  const hasImage   = !!state.image;
  const hasStrokes = state.strokes.length > 0;
  const hasRedo    = state.redoStack.length > 0;
  btnUndo.disabled  = !hasStrokes;
  btnRedo.disabled  = !hasRedo;
  btnClear.disabled = !hasStrokes;
  // Habilitar herramientas de dibujo solo si hay imagen
  document.querySelectorAll('[data-tool]').forEach(btn => {
    if (btn.dataset.tool !== 'pan') btn.disabled = !hasImage;
  });
}

// ============================================================
// DIBUJO — inicio / continuación / confirmación
// ============================================================

function startDrawing(sx, sy) {
  if (!state.image) return;
  const pt = screenToImg(sx, sy);
  state.isDrawing = true;

  const base = {
    tool:    state.activeTool,
    color:   state.strokeColor,
    width:   state.strokeWidth,
    opacity: state.strokeOpacity,
  };

  if (state.activeTool === 'pen' || state.activeTool === 'eraser') {
    state.currentStroke = { ...base, points: [pt] };
  } else {
    // line, rect, ellipse: guardan punto de inicio y punto de fin (actualizado al arrastrar)
    state.currentStroke = { ...base, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  }
}

function continueDrawing(sx, sy) {
  if (!state.isDrawing || !state.currentStroke) return;
  const pt = screenToImg(sx, sy);

  if (state.activeTool === 'pen' || state.activeTool === 'eraser') {
    state.currentStroke.points.push(pt);
  } else {
    state.currentStroke.x2 = pt.x;
    state.currentStroke.y2 = pt.y;
  }
  scheduleRedraw();
}

function finishDrawing() {
  if (!state.isDrawing || !state.currentStroke) return;
  state.isDrawing = false;

  // No guardar trazos vacíos (sin movimiento real)
  const s = state.currentStroke;
  const hasContent =
    (s.points && s.points.length >= 1) ||
    (s.x1 !== undefined && (s.x1 !== s.x2 || s.y1 !== s.y2));

  if (hasContent) {
    commitStroke(state.currentStroke);
  }
  state.currentStroke = null;
  scheduleRedraw();
}

// Añade un trazo al historial y lo renderiza en drawingCanvas
function commitStroke(stroke) {
  state.strokes.push(stroke);
  state.redoStack = []; // nueva acción borra el historial de redo
  renderStroke(dCtx, stroke, false);
  updateButtons();
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
  renderStroke(dCtx, stroke, false);
  updateButtons();
  draw();
}

function clearDrawing() {
  if (state.strokes.length === 0) return;
  state.redoStack = []; // limpiar no es "deshacible"
  state.strokes   = [];
  dCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  updateButtons();
  draw();
}

// ============================================================
// ZOOM — compartido entre ratón y táctil (Fase 0)
// ============================================================

function applyZoom(factor, cx, cy) {
  const newScale     = Math.max(0.05, Math.min(20, state.scale * factor));
  const actualFactor = newScale / state.scale;
  state.panX  = cx - cssW / 2 - (cx - cssW / 2 - state.panX) * actualFactor;
  state.panY  = cy - cssH / 2 - (cy - cssH / 2 - state.panY) * actualFactor;
  state.scale = newScale;
  scheduleRedraw();
}

// ============================================================
// EVENTOS DE RATÓN (PC)
// ============================================================

function setupMouse() {
  // Zoom con rueda
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!state.image) return;
    const rect   = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    applyZoom(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (!state.image || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (state.activeTool === 'pan') {
      state.dragging = true;
      state.lastX    = e.clientX;
      state.lastY    = e.clientY;
    } else {
      startDrawing(sx, sy);
    }
  });

  window.addEventListener('mousemove', e => {
    if (!state.image) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (state.dragging) {
      state.panX += e.clientX - state.lastX;
      state.panY += e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      scheduleRedraw();
    } else if (state.isDrawing) {
      continueDrawing(sx, sy);
    }
  });

  window.addEventListener('mouseup', () => {
    state.dragging = false;
    finishDrawing();
  });
}

// ============================================================
// EVENTOS TÁCTILES (móvil — Samsung A56)
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

    if (e.touches.length === 2) {
      // Dos dedos: siempre pinch-zoom (cancela dibujo si estaba activo)
      if (state.isDrawing) {
        state.isDrawing     = false;
        state.currentStroke = null;
        scheduleRedraw();
      }
      state.dragging    = false;
      state.isPinching  = true;
      state.pinchDist   = getTouchDist(e.touches);
      const mid         = getTouchMid(e.touches);
      state.pinchMidX   = mid.x;
      state.pinchMidY   = mid.y;
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

    if (e.touches.length === 2 || state.isPinching) {
      if (e.touches.length < 2) return;
      // Pellizco: zoom + pan simultáneos
      const rect     = canvas.getBoundingClientRect();
      const newDist  = getTouchDist(e.touches);
      const newMid   = getTouchMid(e.touches);
      const factor   = newDist / state.pinchDist;
      const newScale = Math.max(0.05, Math.min(20, state.scale * factor));
      const actual   = newScale / state.scale;

      // El punto del mundo bajo el midpoint antiguo aparece en el midpoint nuevo
      const oldCx = state.pinchMidX - rect.left;
      const oldCy = state.pinchMidY - rect.top;
      const newCx = newMid.x - rect.left;
      const newCy = newMid.y - rect.top;

      state.panX  = newCx - cssW / 2 - (oldCx - cssW / 2 - state.panX) * actual;
      state.panY  = newCy - cssH / 2 - (oldCy - cssH / 2 - state.panY) * actual;
      state.scale = newScale;

      state.pinchDist = newDist;
      state.pinchMidX = newMid.x;
      state.pinchMidY = newMid.y;
      scheduleRedraw();
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
      scheduleRedraw();
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
      // Se levantó un dedo del pellizco: volver a modo de un dedo
      state.isPinching = false;
      if (state.activeTool === 'pan') {
        // Continuar pan con el dedo que queda
        state.dragging = true;
        state.lastX    = e.touches[0].clientX;
        state.lastY    = e.touches[0].clientY;
      }
      // Si era herramienta de dibujo: no retomar el dibujo automáticamente
      // (el trazo ya se canceló al detectar el segundo dedo)
    }
  }, { passive: false });
}

// ============================================================
// ARRANQUE
// ============================================================

document.addEventListener('DOMContentLoaded', init);
