# UrbanistAI - Contexto del proyecto

## Qué es
PWA para ingenieros de tráfico y técnicos municipales que permite hacer
prototipos visuales de urbanismo táctico (carriles bici, chicanes, pasos
de peatones, peatonalizaciones) directamente sobre fotos de calles.

## Objetivo de los renders
Imágenes PERSUASIVAS y creíbles para convencer a vecinos y políticos.
NO son planos normativos ni medidas exactas. Prioriza el impacto visual
y que parezca real, no la precisión técnica milimétrica.

## Stack y restricciones
- PWA en HTML/CSS/JS vanilla, SIN frameworks pesados, SIN paso de build
- Debe desplegarse en GitHub Pages (solo archivos estáticos)
- Target principal: Samsung A56 (móvil gama media) - optimizar para móvil
- IA pesada (inpainting): Cloudflare Workers AI, capa gratuita
- IA local (segmentación): MobileSAM vía ONNX Runtime Web
- Despliegue: git push a israeldiaz1-afk/URBANISTAI -> GitHub Pages

## Forma de trabajar
- Construir POR FASES, una cosa a la vez, que funcione antes de seguir
- Fase 0: esqueleto PWA (subir foto, canvas, zoom/pan)
- Fase 1: capas y herramientas básicas
- Fase 2: pintura en perspectiva (homografía) - SIN IA
- Fase 3: IA (MobileSAM local + Worker Cloudflare inpainting)
- Prioridad: que funcione en móvil por encima de añadir features
