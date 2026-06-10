// ============================================================
// UrbanistAI — Fase 0
// Canvas, carga de foto, zoom (rueda / pellizco) y pan (arrastrar)
// ============================================================

// ---- Referencias al DOM ------------------------------------
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d');
const fileInput   = document.getElementById('file-input');
const btnUpload   = document.getElementById('btn-upload');
const btnEmpty    = document.getElementById('btn-empty-upload');
const btnReset    = document.getElementById('btn-zoom-reset');
const emptyState  = document.getElementById('empty-state');

// ---- Estado de la aplicación -------------------------------
const state = {
  image:   null,   // HTMLImageElement actualmente cargado
  scale:   1,      // factor de zoom (1 = tamaño ajustado inicial)
  panX:    0,      // desplazamiento horizontal respecto al centro del canvas (px CSS)
  panY:    0,      // desplazamiento vertical  respecto al centro del canvas (px CSS)

  // Arrastre (ratón y un dedo)
  dragging: false,
  lastX:    0,
  lastY:    0,

  // Pellizco (dos dedos)
  pinchDist: 0,    // distancia entre dedos en el último frame
  pinchMidX: 0,    // punto medio entre dedos (coord. cliente X)
  pinchMidY: 0,    // punto medio entre dedos (coord. cliente Y)
};

// Dimensiones del canvas en CSS-pixels (independiente del devicePixelRatio).
// Se actualizan en resizeCanvas() y se usan en todo el código de transformación.
let cssW = 0;
let cssH = 0;

// ============================================================
// INICIALIZACIÓN
// ============================================================

function init() {
  resizeCanvas();
  registerSW();

  // Redimensionar canvas cuando cambia la orientación o el tamaño de ventana
  window.addEventListener('resize', resizeCanvas);

  // Los tres botones de subir foto apuntan al mismo input oculto
  btnUpload.addEventListener('click', () => fileInput.click());
  btnEmpty.addEventListener('click',  () => fileInput.click());
  fileInput.addEventListener('change', handleFile);

  // Resetear vista al encuadre inicial
  btnReset.addEventListener('click', resetView);

  setupMouse();
  setupTouch();
}

// ============================================================
// SERVICE WORKER (offline)
// ============================================================

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW no registrado:', err);
    });
  }
}

// ============================================================
// CANVAS — TAMAÑO Y RENDERIZADO
// ============================================================

// Ajusta el buffer del canvas a los píxeles físicos de la pantalla.
// Debe llamarse al inicio y cada vez que cambia el tamaño de la ventana.
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  cssW = rect.width;
  cssH = rect.height;
  // Buffer en píxeles físicos para imágenes nítidas en pantallas OLED/HiDPI
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  draw();
}

// Dibuja el estado actual en el canvas.
// Aplica la escala DPR para que el resultado sea nítido.
function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!state.image) return;

  ctx.save();

  // 1. Escalar al DPR (px CSS → px físicos)
  ctx.scale(dpr, dpr);

  // 2. Trasladar al centro del canvas + desplazamiento de pan
  ctx.translate(cssW / 2 + state.panX, cssH / 2 + state.panY);

  // 3. Aplicar zoom
  ctx.scale(state.scale, state.scale);

  // 4. Dibujar imagen centrada en el origen local
  ctx.imageSmoothingEnabled  = true;
  ctx.imageSmoothingQuality  = 'high';
  ctx.drawImage(
    state.image,
    -state.image.naturalWidth  / 2,
    -state.image.naturalHeight / 2
  );

  ctx.restore();
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
      state.image = img;
      fitToCanvas();
      emptyState.classList.add('hidden');
      btnReset.disabled = false;
      canvas.style.cursor = 'grab';
      draw();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);

  // Limpiar el input para que el evento 'change' se dispare
  // incluso si el usuario elige la misma foto de nuevo
  e.target.value = '';
}

// Calcula el zoom inicial para que la imagen quepa entera en el canvas
function fitToCanvas() {
  const scaleX = cssW / state.image.naturalWidth;
  const scaleY = cssH / state.image.naturalHeight;
  state.scale = Math.min(scaleX, scaleY);
  state.panX  = 0;
  state.panY  = 0;
}

// Vuelve al encuadre inicial (botón "Centrar")
function resetView() {
  if (!state.image) return;
  fitToCanvas();
  draw();
}

// ============================================================
// ZOOM — función compartida por ratón y táctil
// ============================================================

// Aplica un factor de zoom manteniendo el punto (cx, cy) —en coords CSS
// del canvas— fijo en pantalla. Es decir, lo que hay bajo el cursor/dedo
// no se mueve al hacer zoom.
//
// Derivación matemática:
//   Punto en espacio-mundo: wx = (cx - cssW/2 - panX) / scale
//   Tras zoom:  panX_nuevo = cx - cssW/2 - wx * scale_nuevo
//             = cx - cssW/2 - (cx - cssW/2 - panX) * factor
function applyZoom(factor, cx, cy) {
  const newScale    = Math.max(0.05, Math.min(20, state.scale * factor));
  const actualFactor = newScale / state.scale;  // factor real tras aplicar clamp

  state.panX  = cx - cssW / 2 - (cx - cssW / 2 - state.panX) * actualFactor;
  state.panY  = cy - cssH / 2 - (cy - cssH / 2 - state.panY) * actualFactor;
  state.scale = newScale;

  draw();
}

// ============================================================
// EVENTOS DE RATÓN (PC)
// ============================================================

function setupMouse() {
  // Zoom con la rueda del ratón
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!state.image) return;
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    applyZoom(factor, cx, cy);
  }, { passive: false });

  // Inicio del arrastre
  canvas.addEventListener('mousedown', e => {
    if (!state.image || e.button !== 0) return;
    state.dragging = true;
    state.lastX    = e.clientX;
    state.lastY    = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  // Mover imagen mientras se arrastra
  // Se escucha en window para no perder el evento si el cursor sale del canvas
  window.addEventListener('mousemove', e => {
    if (!state.dragging) return;
    state.panX += e.clientX - state.lastX;
    state.panY += e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    draw();
  });

  // Fin del arrastre
  window.addEventListener('mouseup', () => {
    if (!state.dragging) return;
    state.dragging      = false;
    canvas.style.cursor = state.image ? 'grab' : 'default';
  });
}

// ============================================================
// EVENTOS TÁCTILES (móvil)
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
  // passive: false en todos para poder llamar preventDefault()
  // y evitar que el navegador haga scroll o zoom nativo mientras usamos el canvas

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!state.image) return;

    if (e.touches.length === 1) {
      // Un dedo → pan
      state.dragging = true;
      state.lastX    = e.touches[0].clientX;
      state.lastY    = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      // Dos dedos → pinch zoom
      state.dragging  = false;
      state.pinchDist = getTouchDist(e.touches);
      const mid       = getTouchMid(e.touches);
      state.pinchMidX = mid.x;
      state.pinchMidY = mid.y;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!state.image) return;

    if (e.touches.length === 1 && state.dragging) {
      // Pan con un dedo
      state.panX += e.touches[0].clientX - state.lastX;
      state.panY += e.touches[0].clientY - state.lastY;
      state.lastX = e.touches[0].clientX;
      state.lastY = e.touches[0].clientY;
      draw();

    } else if (e.touches.length === 2) {
      // Pellizco: zoom + pan simultáneos
      const rect     = canvas.getBoundingClientRect();
      const newDist  = getTouchDist(e.touches);
      const newMid   = getTouchMid(e.touches);
      const oldMid   = { x: state.pinchMidX, y: state.pinchMidY };
      const factor   = newDist / state.pinchDist;
      const newScale = Math.max(0.05, Math.min(20, state.scale * factor));
      const actual   = newScale / state.scale;

      // Transformación combinada:
      // - El punto del mundo bajo el midpoint ANTIGUO aparece en el midpoint NUEVO
      // - Fórmula: panX_new = newMid_cx - cssW/2 - (oldMid_cx - cssW/2 - panX) * actual
      const oldCx = oldMid.x - rect.left;
      const oldCy = oldMid.y - rect.top;
      const newCx = newMid.x - rect.left;
      const newCy = newMid.y - rect.top;

      state.panX  = newCx - cssW / 2 - (oldCx - cssW / 2 - state.panX) * actual;
      state.panY  = newCy - cssH / 2 - (oldCy - cssH / 2 - state.panY) * actual;
      state.scale = newScale;

      state.pinchDist = newDist;
      state.pinchMidX = newMid.x;
      state.pinchMidY = newMid.y;

      draw();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length === 0) {
      state.dragging = false;
    } else if (e.touches.length === 1) {
      // El usuario levantó un dedo del pellizco: pasar a modo pan
      state.dragging = true;
      state.lastX    = e.touches[0].clientX;
      state.lastY    = e.touches[0].clientY;
    }
  }, { passive: false });
}

// ============================================================
// ARRANQUE
// ============================================================

document.addEventListener('DOMContentLoaded', init);
