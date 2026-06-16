/* ══════════════════════════════════════════════════════════════════
   PAINT BY NUMBER — script.js  (v2)
   Fixes:
   · Swatch only disabled when ALL regions of that colour are done
   · pointerdown events → works on mobile AND desktop
   · smoothAssignment (majority-vote) before flood-fill → clean zones
   · Auto-fill tiny left-over blobs (< MIN_REGION_PX)
   · Labels positioned as % of canvas → scale correctly on all screens
══════════════════════════════════════════════════════════════════ */
'use strict';

/* ── CONFIG ── */
const PHOTOS = [
  { id: 0, src: 'img/1.png', label: 'foto 1' },
  { id: 1, src: 'img/2.png', label: 'foto 2' },
  { id: 2, src: 'img/3.png', label: 'foto 3' },
];
const MAX_COLORS    = 10;   // fewer = cleaner regions
const KMEANS_ITERS  = 25;
const SAMPLE_STEP   = 3;
const SMOOTH_PASSES = 4;    // majority-vote filter passes before flood-fill
const MIN_REGION_PX = 250;  // auto-fill blobs smaller than this
const OUTLINE_ALPHA = 215;

/* ── STATE ── */
let selectedPhotoIdx = 0;
let gameState = null;

/* ══════════════════════════════════════════
   MENU
══════════════════════════════════════════ */
function buildGrid() {
  const grid = document.getElementById('photosGrid');
  grid.innerHTML = '';
  PHOTOS.forEach(p => {
    const wrap  = document.createElement('div');
    wrap.className = 'photo-wrap';

    const frame = document.createElement('div');
    frame.className = 'photo-frame' + (p.id === selectedPhotoIdx ? ' selected' : '');
    frame.id = 'photoFrame' + p.id;
    frame.onclick = () => { selectedPhotoIdx = p.id; buildGrid(); };

    const img = document.createElement('img');
    img.src = p.src;
    img.alt = p.label;
    img.onerror = function () {
      this.parentElement.innerHTML = '<div class="ph-placeholder">📷</div>';
    };

    const chk = document.createElement('div');
    chk.className = 'photo-check';
    chk.textContent = '✓';

    frame.appendChild(img);
    frame.appendChild(chk);

    const lbl = document.createElement('div');
    lbl.className = 'photo-label';
    lbl.textContent = p.label;

    wrap.appendChild(frame);
    wrap.appendChild(lbl);
    grid.appendChild(wrap);
  });
}

/* ══════════════════════════════════════════
   SCREEN TRANSITIONS
══════════════════════════════════════════ */
function startGame() {
  const photo = PHOTOS[selectedPhotoIdx];
  document.getElementById('menuScreen').style.display  = 'none';
  document.getElementById('gameScreen').style.display  = 'flex';
  document.getElementById('winScreen').style.display   = 'none';
  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('regionLabels').innerHTML    = '';
  document.getElementById('paletteSwatches').innerHTML = '';
  document.getElementById('progressBar').style.width   = '0%';
  gameState = null;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload  = () => processImage(img, photo);
  img.onerror = () => {
    document.getElementById('loadingOverlay').innerHTML =
      '<p style="color:#e05;font-weight:800;">No se pudo cargar la imagen 😢</p>';
  };
  img.src = photo.src;
}

function goMenu() {
  document.getElementById('gameScreen').style.display = 'none';
  document.getElementById('winScreen').style.display  = 'none';
  document.getElementById('menuScreen').style.display = 'flex';
  gameState = null;
}

/* ══════════════════════════════════════════
   IMAGE PROCESSING
══════════════════════════════════════════ */
function processImage(img, photo) {
  /* Defer to let browser render the loading spinner first */
  setTimeout(() => {
    try { _processImage(img, photo); }
    catch (e) {
      console.error(e);
      document.getElementById('loadingOverlay').innerHTML =
        `<p style="color:#e05;font-weight:800;">Error: ${e.message}</p>`;
    }
  }, 80);
}

function _processImage(img) {
  /* ── 1. Scale image down ── */
  const maxDim = 500;
  let gw = img.naturalWidth, gh = img.naturalHeight;
  if (gw > maxDim || gh > maxDim) {
    const s = Math.min(maxDim / gw, maxDim / gh);
    gw = Math.round(gw * s);
    gh = Math.round(gh * s);
  }

  const off    = document.createElement('canvas');
  off.width    = gw; off.height = gh;
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  offCtx.drawImage(img, 0, 0, gw, gh);
  const pixels = offCtx.getImageData(0, 0, gw, gh).data;

  /* ── 2. K-means colour quantisation ── */
  const { palette, assignment } = kmeansQuantize(pixels, gw, gh, MAX_COLORS, KMEANS_ITERS, SAMPLE_STEP);

  /* ── 3. Smooth assignment (majority-vote) → kills tiny fragments ── */
  smoothAssignment(assignment, gw, gh, palette.length, SMOOTH_PASSES);

  /* ── 4. Flood-fill connected regions ── */
  const { regionMap, regions } = labelRegions(assignment, gw, gh);

  /* ── 5. Decide which colours are actually used by player regions ── */
  //   We build a sequential display number for each used colourIdx
  const usedColorSet = new Set();
  regions.forEach((r, rid) => {
    if (r.pixelCount >= MIN_REGION_PX) usedColorSet.add(r.colorIdx);
  });
  const sortedUsedColors = [...usedColorSet].sort((a, b) => a - b);
  // displayNum: colorIdx → 1-based sequential label shown on canvas / palette
  const displayNum = {};
  sortedUsedColors.forEach((cidx, i) => { displayNum[cidx] = i + 1; });

  /* ── 6. Build outline canvas ── */
  const outlineCanvas = buildOutlineCanvas(pixels, regionMap, gw, gh);

  /* ── 7. Size the game canvas ── */
  const canvas  = document.getElementById('gameCanvas');
  const wrapEl  = document.getElementById('canvasWrap');
  const maxCanW = wrapEl.clientWidth  - 24;
  const maxCanH = wrapEl.clientHeight - 24;
  const dispScale = Math.min(maxCanW / gw, maxCanH / gh, 1);
  canvas.width  = gw;
  canvas.height = gh;
  canvas.style.width  = Math.round(gw * dispScale) + 'px';
  canvas.style.height = Math.round(gh * dispScale) + 'px';

  /* ── 8. Build pixel caches ── */
  const outCtx       = outlineCanvas.getContext('2d');
  const baseImgData  = outCtx.getImageData(0, 0, gw, gh);
  const basePixelData = new Uint8ClampedArray(baseImgData.data); // frozen baseline

  /* Edge-pixel flag: pixels with outline colour */
  const isEdgePx = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    if (basePixelData[i*4]   === 37  &&
        basePixelData[i*4+1] === 99  &&
        basePixelData[i*4+2] === 176 &&
        basePixelData[i*4+3] > 100) isEdgePx[i] = 1;
  }

  /* Interior pixel list per region */
  const regionPixels = Array.from({ length: regions.length }, () => []);
  for (let i = 0; i < gw * gh; i++) {
    if (!isEdgePx[i]) regionPixels[regionMap[i]].push(i);
  }

  /* Working buffer — mutated on every draw */
  const workingData = new Uint8ClampedArray(basePixelData);

  /* ── 9. Centroid positions for labels ── */
  const labelPositions = computeLabelPositions(regionMap, regions, gw, gh);

  /* ── 10. Init game state ── */
  gameState = {
    gw, gh, palette, regionMap, regions,
    regionPixels, isEdgePx, basePixelData, workingData, outlineCanvas,
    displayNum,          // colorIdx → display number
    filled:       {},    // rid → true (player) | 'auto'
    selectedRegion: null,
    selectedColor:  null,
    totalRegions:   0,   // set below
    filledCount:    0,
    dispScale,
  };

  /* ── 11. Auto-fill tiny blobs (invisible to player) ── */
  for (let rid = 0; rid < regions.length; rid++) {
    if (regions[rid].pixelCount < MIN_REGION_PX) {
      gameState.filled[rid] = 'auto';
      const [r, g, b] = palette[regions[rid].colorIdx];
      for (const i of regionPixels[rid]) {
        workingData[i*4]   = r;
        workingData[i*4+1] = g;
        workingData[i*4+2] = b;
        workingData[i*4+3] = 255;
      }
    } else {
      gameState.totalRegions++;
    }
  }

  /* ── 12. Render + build UI ── */
  commitDraw();
  buildPalette(palette, regions, displayNum);
  buildRegionLabels(labelPositions, gw, gh, regions, displayNum);
  setupCanvasInteraction(canvas);
  document.getElementById('loadingOverlay').style.display = 'none';
}

/* ══════════════════════════════════════════
   K-MEANS COLOUR QUANTISATION
══════════════════════════════════════════ */
function kmeansQuantize(pixels, w, h, k, maxIter, step) {
  const n = w * h;

  /* Collect samples */
  const samples = [];
  for (let i = 0; i < n; i += step) {
    if (pixels[i*4+3] < 128) continue;
    samples.push([pixels[i*4], pixels[i*4+1], pixels[i*4+2]]);
  }
  if (samples.length === 0) throw new Error('No opaque pixels found');

  /* k-means++ initialisation */
  const centroids = [samples[Math.floor(Math.random() * samples.length)]];
  while (centroids.length < Math.min(k, samples.length)) {
    const dists = samples.map(s => {
      let minD = Infinity;
      for (const c of centroids) { const d = colorDistSq(s, c); if (d < minD) minD = d; }
      return minD;
    });
    const total = dists.reduce((a, b) => a + b, 0);
    if (total === 0) { centroids.push([...samples[centroids.length]]); continue; }
    let r = Math.random() * total, idx = 0;
    for (let i = 0; i < dists.length; i++) { r -= dists[i]; if (r <= 0) { idx = i; break; } }
    centroids.push([...samples[idx]]);
  }
  const K = centroids.length;

  /* Iterate */
  for (let iter = 0; iter < maxIter; iter++) {
    const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i += step) {
      if (pixels[i*4+3] < 128) continue;
      const rv = pixels[i*4], gv = pixels[i*4+1], bv = pixels[i*4+2];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < K; c++) {
        const d = colorDistSq([rv, gv, bv], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      sums[best][0] += rv; sums[best][1] += gv; sums[best][2] += bv; sums[best][3]++;
    }
    let moved = false;
    for (let c = 0; c < K; c++) {
      if (!sums[c][3]) continue;
      const nr = sums[c][0]/sums[c][3], ng = sums[c][1]/sums[c][3], nb = sums[c][2]/sums[c][3];
      if (Math.abs(nr-centroids[c][0])>0.5 || Math.abs(ng-centroids[c][1])>0.5 || Math.abs(nb-centroids[c][2])>0.5) moved = true;
      centroids[c] = [nr, ng, nb];
    }
    if (!moved && iter > 3) break;
  }

  /* Final assignment for ALL pixels */
  const assignment = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (pixels[i*4+3] < 128) { assignment[i] = 0; continue; }
    const rv = pixels[i*4], gv = pixels[i*4+1], bv = pixels[i*4+2];
    let best = 0, bestD = Infinity;
    for (let c = 0; c < K; c++) {
      const d = colorDistSq([rv, gv, bv], centroids[c]);
      if (d < bestD) { bestD = d; best = c; }
    }
    assignment[i] = best;
  }

  const palette = centroids.map(c => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
  return { palette, assignment };
}

function colorDistSq(a, b) {
  return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
}

/* ══════════════════════════════════════════
   SMOOTH ASSIGNMENT
   3×3 majority-vote filter — eliminates tiny colour fragments
   before flood-fill so regions are large and clean.
══════════════════════════════════════════ */
function smoothAssignment(assignment, w, h, k, passes) {
  const n = w * h;
  const counts = new Int32Array(k);
  let curr = new Uint8Array(assignment);
  let next = new Uint8Array(n);

  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            counts[curr[ny * w + nx]]++;
          }
        }
        let best = curr[y*w+x], bestC = 0;
        for (let c = 0; c < k; c++) {
          if (counts[c] > bestC) { bestC = counts[c]; best = c; }
        }
        next[y*w+x] = best;
      }
    }
    /* Swap buffers */
    const tmp = curr; curr = next; next = tmp;
  }
  assignment.set(curr);
}

/* ══════════════════════════════════════════
   FLOOD-FILL REGION LABELLING
══════════════════════════════════════════ */
function labelRegions(assignment, w, h) {
  const n         = w * h;
  const regionMap = new Int32Array(n).fill(-1);
  const regions   = [];
  const queue     = new Int32Array(n);
  let   nextId    = 0;

  for (let start = 0; start < n; start++) {
    if (regionMap[start] !== -1) continue;
    const colorIdx = assignment[start];
    const rid      = nextId++;
    regions.push({ colorIdx, pixelCount: 0 });

    let head = 0, tail = 0;
    queue[tail++]      = start;
    regionMap[start]   = rid;

    while (head < tail) {
      const px = queue[head++];
      regions[rid].pixelCount++;
      const x = px % w, y = (px / w) | 0;

      if (x > 0   && regionMap[px-1] === -1 && assignment[px-1] === colorIdx) { regionMap[px-1]=rid; queue[tail++]=px-1; }
      if (x < w-1 && regionMap[px+1] === -1 && assignment[px+1] === colorIdx) { regionMap[px+1]=rid; queue[tail++]=px+1; }
      if (y > 0   && regionMap[px-w] === -1 && assignment[px-w] === colorIdx) { regionMap[px-w]=rid; queue[tail++]=px-w; }
      if (y < h-1 && regionMap[px+w] === -1 && assignment[px+w] === colorIdx) { regionMap[px+w]=rid; queue[tail++]=px+w; }
    }
  }
  return { regionMap, regions };
}

/* ══════════════════════════════════════════
   BUILD OUTLINE CANVAS
   Greyscale + blue (#2563b0) borders between regions
══════════════════════════════════════════ */
function buildOutlineCanvas(origPixels, regionMap, w, h) {
  const cvs    = document.createElement('canvas');
  cvs.width    = w; cvs.height = h;
  const ctx    = cvs.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  const d       = imgData.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i   = y * w + x;
      const rid = regionMap[i];
      let isEdge = false;
      if (!isEdge && x > 0   && regionMap[i-1] !== rid) isEdge = true;
      if (!isEdge && x < w-1 && regionMap[i+1] !== rid) isEdge = true;
      if (!isEdge && y > 0   && regionMap[i-w] !== rid) isEdge = true;
      if (!isEdge && y < h-1 && regionMap[i+w] !== rid) isEdge = true;

      if (isEdge) {
        d[i*4]=37; d[i*4+1]=99; d[i*4+2]=176; d[i*4+3]=OUTLINE_ALPHA;
      } else {
        const rv = origPixels[i*4], gv = origPixels[i*4+1], bv = origPixels[i*4+2];
        const grey  = 0.299*rv + 0.587*gv + 0.114*bv;
        const light = Math.min(255, Math.round(195 + grey * 0.24));
        d[i*4]=light; d[i*4+1]=light; d[i*4+2]=Math.min(255,light+18); d[i*4+3]=255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return cvs;
}

/* ══════════════════════════════════════════
   LABEL POSITIONS (centroid per region)
══════════════════════════════════════════ */
function computeLabelPositions(regionMap, regions, w, h) {
  const sumX = new Float64Array(regions.length);
  const sumY = new Float64Array(regions.length);
  const cnt  = new Float64Array(regions.length);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rid = regionMap[y*w+x];
      sumX[rid] += x; sumY[rid] += y; cnt[rid]++;
    }
  }

  return regions.map((r, rid) => ({
    rid,
    colorIdx: r.colorIdx,
    cx: cnt[rid] > 0 ? sumX[rid] / cnt[rid] : 0,
    cy: cnt[rid] > 0 ? sumY[rid] / cnt[rid] : 0,
  }));
}

/* ══════════════════════════════════════════
   BUILD PALETTE UI
══════════════════════════════════════════ */
function buildPalette(palette, regions, displayNum) {
  const container = document.getElementById('paletteSwatches');
  container.innerHTML = '';

  /* Only show colours that have at least one player region */
  const hasPlayerRegion = new Array(palette.length).fill(false);
  regions.forEach((r, rid) => {
    if (gameState.filled[rid] !== 'auto') hasPlayerRegion[r.colorIdx] = true;
  });

  palette.forEach(([rv, gv, bv], idx) => {
    if (!hasPlayerRegion[idx]) return;

    const row = document.createElement('div');
    row.className = 'swatch-row';
    row.id = 'swatch-' + idx;
    row.dataset.colorIdx = idx;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.onclick = () => selectColor(idx);
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') selectColor(idx); };

    const circle = document.createElement('div');
    circle.className = 'swatch-circle';
    circle.style.background = `rgb(${rv},${gv},${bv})`;

    const num = document.createElement('span');
    num.className = 'swatch-num';
    num.textContent = displayNum[idx] ?? (idx + 1);

    row.appendChild(circle);
    row.appendChild(num);
    container.appendChild(row);
  });
}

/* ══════════════════════════════════════════
   BUILD REGION LABELS
   Positions as % of canvas → scale on all screen sizes
══════════════════════════════════════════ */
function buildRegionLabels(labelPositions, gw, gh, regions, displayNum) {
  const labelsDiv = document.getElementById('regionLabels');
  labelsDiv.innerHTML = '';

  const seen = new Set();
  labelPositions.forEach(lp => {
    const r = regions[lp.rid];
    if (gameState.filled[lp.rid] === 'auto') return; // auto-filled — no label
    if (r.pixelCount < MIN_REGION_PX)        return;
    if (seen.has(lp.rid))                    return;
    seen.add(lp.rid);

    const el = document.createElement('div');
    el.className = 'region-num';
    el.id = 'label-' + lp.rid;
    el.textContent = displayNum[lp.colorIdx] ?? (lp.colorIdx + 1);

    /* Percentage positioning → works regardless of canvas display size */
    el.style.left = (lp.cx / gw * 100).toFixed(2) + '%';
    el.style.top  = (lp.cy / gh * 100).toFixed(2) + '%';

    labelsDiv.appendChild(el);
  });
}

/* ══════════════════════════════════════════
   CANVAS INTERACTION
   Uses pointerdown → works on mobile AND desktop
══════════════════════════════════════════ */
function setupCanvasInteraction(canvas) {
  /* Remove any previous listener to avoid duplicates on game restart */
  canvas.replaceWith(canvas.cloneNode(true));
  const freshCanvas = document.getElementById('gameCanvas');
  freshCanvas.addEventListener('pointerdown', onCanvasPointer, { passive: false });
}

function onCanvasPointer(e) {
  e.preventDefault();
  if (!gameState) return;

  const canvas  = document.getElementById('gameCanvas');
  const rect    = canvas.getBoundingClientRect();
  const scaleX  = gameState.gw / rect.width;
  const scaleY  = gameState.gh / rect.height;
  const px = Math.floor((e.clientX - rect.left) * scaleX);
  const py = Math.floor((e.clientY - rect.top)  * scaleY);

  if (px < 0 || py < 0 || px >= gameState.gw || py >= gameState.gh) return;

  const pixelIdx = py * gameState.gw + px;
  const regionId = gameState.regionMap[pixelIdx];

  if (gameState.filled[regionId] === 'auto') return; // invisible auto region
  if (gameState.filled[regionId] === true)   return; // already correctly filled

  gameState.selectedRegion = regionId;
  highlightSelectedRegion(regionId);

  if (gameState.selectedColor !== null) {
    tryFill(regionId, gameState.selectedColor);
  } else {
    document.getElementById('paletteHint').textContent = 'ahora elige un color 🎨';
  }
}

function selectColor(colorIdx) {
  if (!gameState) return;
  gameState.selectedColor = colorIdx;

  document.querySelectorAll('.swatch-row').forEach(r => r.classList.remove('active'));
  const sw = document.getElementById('swatch-' + colorIdx);
  if (sw) sw.classList.add('active');

  document.getElementById('paletteHint').textContent = 'toca la región a colorear~';

  if (gameState.selectedRegion !== null && !gameState.filled[gameState.selectedRegion]) {
    tryFill(gameState.selectedRegion, colorIdx);
  }
}

/* ══════════════════════════════════════════
   TRY FILL
══════════════════════════════════════════ */
function tryFill(regionId, colorIdx) {
  if (!gameState) return;
  const region = gameState.regions[regionId];
  if (!region || gameState.filled[regionId]) return;

  if (region.colorIdx === colorIdx) {
    /* ✅ Correct! */
    fillRegion(regionId, gameState.palette[colorIdx]);
    gameState.filled[regionId] = true;
    gameState.filledCount++;
    gameState.selectedRegion = null;

    /* Fade out label */
    const lbl = document.getElementById('label-' + regionId);
    if (lbl) { lbl.style.opacity = '0'; lbl.style.transition = 'opacity 0.4s'; }

    updateProgress();

    /* ── FIX: Only grey-out the swatch when ALL regions of this colour are filled ── */
    checkSwatchComplete(colorIdx);

    document.getElementById('paletteHint').textContent = '¡bien! sigue así ✨';

    if (gameState.filledCount >= gameState.totalRegions) {
      setTimeout(showWinScreen, 700);
    }
  } else {
    /* ❌ Wrong — shake canvas + flash region red */
    const canvas = document.getElementById('gameCanvas');
    canvas.classList.remove('shake');
    void canvas.offsetWidth; // force reflow to restart animation
    canvas.classList.add('shake');
    canvas.addEventListener('animationend', () => canvas.classList.remove('shake'), { once: true });

    flashRegionError(regionId);
    document.getElementById('paletteHint').textContent = 'ese no es… intenta otro 🙈';
  }
}

/**
 * Mark a swatch as "complete" (grey, non-interactive) only when every
 * player region that belongs to that colour has been correctly filled.
 * Auto-filled blobs don't count as player work.
 */
function checkSwatchComplete(colorIdx) {
  const { regions, filled } = gameState;
  const allDone = regions.every((r, rid) => {
    if (r.colorIdx !== colorIdx) return true; // different colour → not our concern
    if (filled[rid] === 'auto') return true;  // auto-filled → counts as done
    return filled[rid] === true;              // player must have filled it
  });

  if (allDone) {
    const sw = document.getElementById('swatch-' + colorIdx);
    if (sw) sw.classList.add('correct');
  }
}

/* ══════════════════════════════════════════
   DRAW HELPERS
══════════════════════════════════════════ */

/** Flush workingData to the visible canvas */
function commitDraw() {
  const canvas = document.getElementById('gameCanvas');
  const ctx    = canvas.getContext('2d');
  const { gw, gh, workingData } = gameState;
  const imgData = ctx.createImageData(gw, gh);
  imgData.data.set(workingData);
  ctx.putImageData(imgData, 0, 0);
}

/** Reset workingData to the pristine outline baseline */
function resetWorkingData() {
  gameState.workingData.set(gameState.basePixelData);
}

/** Paint all correctly-filled regions (player + auto) into workingData */
function paintFilledRegions() {
  const { palette, regions, regionPixels, filled, workingData } = gameState;
  for (const [ridStr, status] of Object.entries(filled)) {
    if (!status) continue; // falsy → skip
    const rid = Number(ridStr);
    const [rv, gv, bv] = palette[regions[rid].colorIdx];
    for (const i of regionPixels[rid]) {
      workingData[i*4]=rv; workingData[i*4+1]=gv; workingData[i*4+2]=bv; workingData[i*4+3]=255;
    }
  }
}

/** Permanently paint a region with a colour */
function fillRegion(regionId, color) {
  const [rv, gv, bv] = color;
  for (const i of gameState.regionPixels[regionId]) {
    gameState.workingData[i*4]=rv; gameState.workingData[i*4+1]=gv;
    gameState.workingData[i*4+2]=bv; gameState.workingData[i*4+3]=255;
  }
  commitDraw();
}

/** Highlight a selected-but-unfilled region with a blue tint */
function highlightSelectedRegion(regionId) {
  const { regionPixels, workingData, filled } = gameState;

  resetWorkingData();
  paintFilledRegions();

  if (!filled[regionId]) {
    for (const i of regionPixels[regionId]) {
      workingData[i*4]   = Math.min(255, (workingData[i*4]   * 0.35 + 155 * 0.65)) | 0;
      workingData[i*4+1] = Math.min(255, (workingData[i*4+1] * 0.35 + 196 * 0.65)) | 0;
      workingData[i*4+2] = Math.min(255, (workingData[i*4+2] * 0.35 + 250 * 0.65)) | 0;
    }
  }

  commitDraw();
}

/** Flash a region red, then restore */
function flashRegionError(regionId) {
  const { regionPixels, workingData } = gameState;

  /* Save current pixels for this region */
  const saved = regionPixels[regionId].map(i =>
    [workingData[i*4], workingData[i*4+1], workingData[i*4+2], workingData[i*4+3]]);

  /* Flash red */
  for (const i of regionPixels[regionId]) {
    workingData[i*4]=238; workingData[i*4+1]=68; workingData[i*4+2]=68; workingData[i*4+3]=255;
  }
  commitDraw();

  /* Restore after 380 ms */
  setTimeout(() => {
    if (!gameState) return;
    regionPixels[regionId].forEach((idx, j) => {
      workingData[idx*4]=saved[j][0]; workingData[idx*4+1]=saved[j][1];
      workingData[idx*4+2]=saved[j][2]; workingData[idx*4+3]=saved[j][3];
    });
    commitDraw();
  }, 380);
}

/* ══════════════════════════════════════════
   PROGRESS BAR
══════════════════════════════════════════ */
function updateProgress() {
  if (!gameState || !gameState.totalRegions) return;
  const pct = (gameState.filledCount / gameState.totalRegions) * 100;
  document.getElementById('progressBar').style.width = Math.min(100, pct) + '%';
}

/* ══════════════════════════════════════════
   WIN SCREEN
══════════════════════════════════════════ */
function showWinScreen() {
  document.getElementById('gameScreen').style.display = 'none';
  document.getElementById('winScreen').style.display  = 'flex';

  const srcCanvas = document.getElementById('gameCanvas');
  const winCanvas = document.getElementById('winCanvas');
  winCanvas.width  = srcCanvas.width;
  winCanvas.height = srcCanvas.height;
  const maxW  = Math.min(300, window.innerWidth - 60);
  const scale = Math.min(maxW / srcCanvas.width, 220 / srcCanvas.height, 1);
  winCanvas.style.width  = Math.round(srcCanvas.width  * scale) + 'px';
  winCanvas.style.height = Math.round(srcCanvas.height * scale) + 'px';
  winCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);

  const starsEl = document.getElementById('winStars');
  const chars   = ['⭐', '✨', '💫', '🌟', '★', '✦'];
  setInterval(() => {
    starsEl.textContent = [0,1,2].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  }, 500);
}

/* ── INIT ── */
buildGrid();