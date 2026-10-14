/**
 * Viewshed (가시권) 분석 - MapLibre + Pixi.js
 *
 * 구조
 *  1. CONFIG / 배경 지도
 *  2. 로그 / 진행률
 *  3. 지도 / Pixi 오버레이 동기화
 *  4. 기준점 / 격자 / 미리보기
 *  5. 분석 (워커 호출)
 *  6. 시각화 (결과 1회 빌드)
 *  7. 설정 패널 / UI 이벤트
 *
 * 오버레이 동기화: 도형은 기준점을 원점으로 하는 로컬 좌표(메르카토르 기반)로 한 번만 그려 두고,
 * 지도가 렌더될 때마다 레이어의 2D 행렬(이동·배율·회전)만 갱신한 뒤 같은 프레임에 Pixi 를 직접
 * 렌더한다. 프레임당 비용이 거의 없고 지도와 한 프레임도 어긋나지 않는다. (pitch 는 원근 변환이라 미지원)
 */
import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';
import * as PIXI from 'https://cdn.jsdelivr.net/npm/pixi.js@8.19.0/dist/pixi.min.mjs';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.min.js';
import { destination, toMercator, fromMercator, normalizeSettings } from './geo.js';

// ───────────────────────────── 1. CONFIG / 배경 지도 ─────────────────────────────
const CONFIG = {
  center: [127.0276, 37.4979], // 초기 중심 (강남역)
  zoom: 13,
  localUnit: 1e7, // 메르카토르 좌표(0~1) → Pixi 로컬 좌표 배율 (float 정밀도 확보용)
  dotRadiusPx: 2.5, // 미리보기 간격 점 크기
  color: { preview: 0x111111, visible: 0x2ecc40, hidden: 0xff2d2d, marker: '#2563eb' },
  fillAlpha: 0.35,
};

/** env.js 가 주입한 API 키 (없으면 빈 객체) */
const ENV = window.ENV ?? {};

/**
 * 배경 지도. url 이 있으면 스타일 URL(벡터), tiles 가 있으면 래스터 스타일을 생성.
 * key 가 필요한 지도는 ENV 에 키가 있을 때만 목록에 노출된다.
 */
const BASE_STYLES = {
  liberty: { name: 'OpenFreeMap Liberty', url: 'https://tiles.openfreemap.org/styles/liberty' },
  bright: { name: 'OpenFreeMap Bright', url: 'https://tiles.openfreemap.org/styles/bright' },
  positron: { name: 'OpenFreeMap Positron', url: 'https://tiles.openfreemap.org/styles/positron' },
  osm: { name: 'OpenStreetMap', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors' },
  topo: { name: 'OpenTopoMap', tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'], attribution: '© OpenTopoMap (CC-BY-SA)' },
  maptilerStreets: { name: 'MapTiler Streets', key: 'MAPTILER_KEY', url: (k) => `https://api.maptiler.com/maps/streets-v2/style.json?key=${k}` },
  maptilerSatellite: { name: 'MapTiler Satellite', key: 'MAPTILER_KEY', url: (k) => `https://api.maptiler.com/maps/hybrid/style.json?key=${k}` },
  cartoVoyager: { name: 'CARTO Voyager', key: 'CARTO_KEY', tiles: (k) => [`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?api_key=${k}`], attribution: '© CARTO © OpenStreetMap contributors' },
};

/** 사용 가능한(키가 없거나 키가 있는) 스타일만 { 표시명: key } 로 */
const availableStyles = () =>
  Object.fromEntries(Object.entries(BASE_STYLES).filter(([, s]) => !s.key || ENV[s.key]).map(([k, s]) => [s.name, k]));

function buildStyle(key) {
  const s = BASE_STYLES[key];
  const apiKey = s.key ? ENV[s.key] : '';
  const resolve = (v) => (typeof v === 'function' ? v(apiKey) : v);
  if (s.url) return resolve(s.url);
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: resolve(s.tiles), tileSize: 256, attribution: s.attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ───────────────────────────── 2. 로그 / 진행률 ─────────────────────────────
const logEl = document.getElementById('log');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

/** @param {'info'|'success'|'error'} level */
function log(message, level = 'info') {
  const line = document.createElement('div');
  line.className = level;
  line.innerHTML = `<span class="time">${new Date().toLocaleTimeString('ko-KR', { hour12: false })}</span>`;
  line.append(message);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(ratio, text) {
  progressBar.style.width = `${Math.round(ratio * 100)}%`;
  progressText.textContent = text;
}

// ───────────────────────────── 3. 지도 / Pixi 오버레이 동기화 ─────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle('liberty'),
  center: CONFIG.center,
  zoom: CONFIG.zoom,
  // 오버레이를 2D 행렬(이동·배율·회전)로 동기화하므로 원근이 생기는 pitch 는 비활성화
  maxPitch: 0,
  pitchWithRotate: false,
  touchPitch: false,
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');

const pixi = new PIXI.Application();
/** 기준점을 원점으로 하는 레이어. 지도 뷰가 바뀌면 이 레이어의 행렬만 갱신한다 */
const layer = new PIXI.Container();
const previewGfx = new PIXI.Graphics();
const resultGfx = new PIXI.Graphics();
layer.addChild(previewGfx, resultGfx);

const state = {
  marker: null, // 기준점 [lng, lat]
  markerMercator: null,
  markerEl: null, // maplibregl.Marker
  pxPerLocal: 1, // 로컬 단위 → 화면 px 배율 (syncOverlay 에서 갱신)
  showPreview: false, // 가시화 후에는 미리보기(검정)를 숨김
  analysisId: 0, // 새 기준점/분석 시 증가 → 진행 중인 작업 취소용
  grid: null, // { key, corners, centers } 꼭짓점 격자 캐시
  needsUpdate: true, // 도형이 바뀌어 다시 렌더가 필요한지
  lastMatrix: null, // 직전 렌더에 쓴 레이어 행렬 (같으면 렌더 스킵)
  resultCache: new Map(), // 분석 결과 캐시: key → { observerElevation, visible }
};
const RESULT_CACHE_SIZE = 20;

/** 도형을 바꿨을 때 호출 → 다음 renderOverlay 에서 반드시 렌더 */
const invalidate = () => { state.needsUpdate = true; };

/** 경위도 → 기준점 기준 Pixi 로컬 좌표 */
function toLocal(lngLat) {
  const [mx, my] = toMercator(lngLat);
  const [ox, oy] = state.markerMercator;
  return [(mx - ox) * CONFIG.localUnit, (my - oy) * CONFIG.localUnit];
}

/**
 * 지도 뷰 → 레이어 행렬. 기준점과 메르카토르 축 방향으로 조금 떨어진 두 점을 투영해
 * 로컬 좌표 → 화면 px 의 affine 행렬(배율·회전 포함)을 직접 구한다.
 */
function syncOverlay() {
  if (!state.marker) return;
  const d = 1e-5; // 메르카토르 단위 오프셋
  const [ox, oy] = state.markerMercator;
  const o = map.project(state.marker);
  const px = map.project(fromMercator([ox + d, oy]));
  const py = map.project(fromMercator([ox, oy + d]));
  const k = 1 / (d * CONFIG.localUnit);
  const [a, b, c, dd] = [(px.x - o.x) * k, (px.y - o.y) * k, (py.x - o.x) * k, (py.y - o.y) * k];
  const matrix = new PIXI.Matrix(a, b, c, dd, o.x, o.y);
  if (state.lastMatrix?.equals(matrix)) return; // 뷰가 그대로면 행렬도 그대로
  layer.setFromMatrix(matrix);
  state.lastMatrix = matrix;
  state.pxPerLocal = Math.hypot(a, b);
  state.needsUpdate = true;
}

/**
 * 지도와 같은 프레임에 오버레이를 렌더 (Pixi 자동 ticker 미사용).
 * 뷰(행렬)도 도형도 안 바뀌었으면 건너뛴다 — 타일 로딩·라벨 페이드로 오는 render 이벤트에 대응.
 */
function renderOverlay() {
  syncOverlay();
  if (!state.needsUpdate) return;
  pixi.render();
  state.needsUpdate = false;
}

// ───────────────────────────── 4. 기준점 / 격자 / 미리보기 ─────────────────────────────
/** lil-gui 가 바인딩하는 설정값 */
const settings = {
  style: 'liberty',
  overlay: true, // Pixi 오버레이 표시 (성능 진단용)
  range: 1000, // m
  azimuthCount: 36,
  interval: 100, // m
  observerHeight: 1.7, // m
  analyze: () => runAnalysis(),
};

const ui = {
  analyzeBtn: null, // lil-gui controller
  contextMenu: document.getElementById('context-menu'),
  createMarkerBtn: document.getElementById('create-marker-btn'),
  clearLogBtn: document.getElementById('clear-log-btn'),
};

/**
 * 꼭짓점 격자 (기준점·설정이 바뀔 때만 재계산).
 *  corners[b][k]: 셀 경계 방위각 b(=(b-0.5)·step), 링 k 의 로컬 좌표 — 이웃 셀이 공유
 *  centers[i][k]: 분석 지점(중심 방위각 i, 링 k) 의 로컬 좌표 — 미리보기 방사선·점
 *  셀 (i, k) = corners[i][k-1] → corners[i][k] → corners[i+1][k] → corners[i+1][k-1]
 */
function getGrid(s) {
  const key = JSON.stringify([state.marker, s.azimuthCount, s.ringDistances]);
  if (state.grid?.key === key) return state.grid;
  const step = 360 / s.azimuthCount;
  const ray = (bearing) => s.ringDistances.map((r) => toLocal(destination(state.marker, bearing, r)));
  const corners = Array.from({ length: s.azimuthCount }, (_, b) => ray((b - 0.5) * step));
  const centers = Array.from({ length: s.azimuthCount }, (_, i) => ray(i * step));
  return (state.grid = { key, corners, centers });
}

/** 셀 (i, k) 의 꼭짓점 4개 (평면 배열) */
function cellPoints({ corners }, i, k) {
  const next = corners[(i + 1) % corners.length];
  return [...corners[i][k - 1], ...corners[i][k], ...next[k], ...next[k - 1]];
}

function setReferencePoint(lngLat) {
  state.analysisId++; // 진행 중이던 분석/애니메이션 취소
  state.marker = lngLat;
  state.markerMercator = toMercator(lngLat);
  state.markerEl?.remove();
  state.markerEl = new maplibregl.Marker({ color: CONFIG.color.marker }).setLngLat(lngLat).addTo(map);

  resultGfx.clear();
  state.showPreview = true;
  syncOverlay(); // 새 원점 기준 배율을 먼저 구해야 점 크기가 맞는다
  drawPreview();
  renderOverlay();
  setProgress(0, '대기 중');
  ui.analyzeBtn.enable();
  log(`기준점 지정: ${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
}

/** 검정 미리보기: 방위각 방사선 + 범위 원 + 간격 지점(점). 점 크기는 줌이 바뀔 때만 다시 계산 */
function drawPreview() {
  previewGfx.clear();
  invalidate();
  if (!state.marker || !state.showPreview) return;
  const s = normalizeSettings(settings);
  const { centers } = getGrid(s);
  const dotRadius = CONFIG.dotRadiusPx / state.pxPerLocal; // 화면 px → 로컬 단위

  for (const ray of centers) previewGfx.moveTo(0, 0).lineTo(...ray[s.ringCount]);
  const circle = Array.from({ length: 72 }, (_, j) => toLocal(destination(state.marker, j * 5, s.range)));
  previewGfx.poly(circle.flat(), true).stroke({ color: CONFIG.color.preview, pixelLine: true });

  for (const ray of centers) for (let k = 1; k <= s.ringCount; k++) previewGfx.circle(...ray[k], dotRadius);
  previewGfx.fill(CONFIG.color.preview);
}

// ───────────────────────────── 5. 분석 (워커 호출) ─────────────────────────────
const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });

/** 워커에 분석을 요청하고 결과를 기다린다. 진행 메시지는 로그/진행률에 반영 */
function analyzeInWorker(id, s) {
  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      switch (data.type) {
        case 'tiles':
          log(`고도 타일 로드 ${data.done}/${data.total}`);
          setProgress(data.done / data.total, `타일 ${data.done}/${data.total}`);
          break;
        case 'progress': {
          const pct = (data.done / data.total) * 100;
          log(`${data.total} 개 중 ${data.done} 개 완료... (${pct.toFixed(2)}%)`);
          setProgress(data.done / data.total, `분석 ${pct.toFixed(1)}%`);
          break;
        }
        case 'result':
          worker.removeEventListener('message', onMessage);
          resolve(data);
          break;
        case 'error':
          worker.removeEventListener('message', onMessage);
          reject(new Error(data.message));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'analyze', id, marker: state.marker, settings: s });
  });
}

/** 같은 기준점·설정이면 워커를 거치지 않고 캐시된 결과를 쓴다 (최근 RESULT_CACHE_SIZE 건 유지) */
async function analyzeCached(id, s) {
  const key = JSON.stringify([state.marker, s.azimuthCount, s.ringDistances, s.observerHeight]);
  const cached = state.resultCache.get(key);
  if (cached) {
    log('캐시된 분석 결과 사용');
    return cached;
  }
  const result = await analyzeInWorker(id, s);
  state.resultCache.set(key, result);
  if (state.resultCache.size > RESULT_CACHE_SIZE) state.resultCache.delete(state.resultCache.keys().next().value);
  return result;
}

async function runAnalysis() {
  if (!state.marker) return;
  const id = ++state.analysisId;
  const s = normalizeSettings(settings);
  ui.analyzeBtn.disable();
  resultGfx.clear();
  state.showPreview = true;
  drawPreview();
  renderOverlay();

  try {
    log(`분석 시작 — 범위 ${s.range}m / 방위각 ${s.azimuthCount}개 / 간격 ${s.interval}m / 관측자 ${s.observerHeight}m`);
    const { observerElevation, sampleStep, visible } = await analyzeCached(id, s);
    if (id !== state.analysisId) return;
    log(`기준점 지표 고도 ${observerElevation.toFixed(1)}m · 시선 샘플 간격 ${sampleStep.toFixed(1)}m · 100% 완료, 가시화 시작`, 'success');
    reveal(s, visible);
  } catch (err) {
    log(`오류: ${err.message}`, 'error');
    setProgress(0, '오류');
  } finally {
    if (id === state.analysisId) ui.analyzeBtn.enable();
  }
}

// ───────────────────────────── 6. 시각화 ─────────────────────────────
/**
 * 결과 셀 전체를 한 번에 빌드. 반투명 채움 + 같은 색의 불투명 테두리.
 * Pixi 배처는 토폴로지(삼각형 ↔ pixelLine 라인)가 바뀔 때마다 배치를 끊으므로,
 * 셀마다 채움·테두리를 번갈아 넣지 않고 채움 전부 → 테두리 전부 순으로 넣어 드로우콜을 2개로 유지한다.
 */
function buildResult(s, visible) {
  const grid = getGrid(s);
  const colorOf = (i, k) => (visible[i][k - 1] ? CONFIG.color.visible : CONFIG.color.hidden);
  resultGfx.clear();
  invalidate();
  for (let k = 1; k <= s.ringCount; k++)
    for (let i = 0; i < s.azimuthCount; i++)
      resultGfx.poly(cellPoints(grid, i, k), true).fill({ color: colorOf(i, k), alpha: CONFIG.fillAlpha });
  for (let k = 1; k <= s.ringCount; k++)
    for (let i = 0; i < s.azimuthCount; i++)
      resultGfx.poly(cellPoints(grid, i, k), true).stroke({ color: colorOf(i, k), alpha: 1, pixelLine: true });
}

/** 결과를 한 번에 빌드·렌더. 미리보기(검정)는 제거 */
function reveal(s, visible) {
  state.showPreview = false;
  previewGfx.clear();
  buildResult(s, visible);
  renderOverlay();

  const total = s.azimuthCount * s.ringCount;
  const visibleCount = visible.flat().filter(Boolean).length;
  setProgress(1, '완료');
  log(`가시화 완료 — 가시 ${visibleCount} / ${total} 셀 (${((visibleCount / total) * 100).toFixed(1)}%)`, 'success');
}

// ───────────────────────────── 7. 설정 패널 / UI 이벤트 ─────────────────────────────
/** 우상단 설정 패널 (lil-gui) */
function buildGui() {
  const gui = new GUI({ container: document.getElementById('gui'), title: '설정', width: 260 });
  // 설정을 바꾸면 새 분석 대상이므로 미리보기를 다시 표시
  const refreshPreview = () => { state.showPreview = true; drawPreview(); renderOverlay(); };

  gui.add(settings, 'style', availableStyles()).name('배경 지도').onChange((key) => map.setStyle(buildStyle(key)));
  gui.add(settings, 'overlay').name('오버레이 표시').onChange((on) => { layer.visible = on; invalidate(); renderOverlay(); });

  const analysisFolder = gui.addFolder('분석');
  analysisFolder.add(settings, 'range', 100, 10000, 10).name('범위 (m)').onChange(refreshPreview);
  analysisFolder.add(settings, 'azimuthCount', 4, 360, 1).name('분석 방위각 개수').onChange(refreshPreview);
  analysisFolder.add(settings, 'interval', 5, 1000, 5).name('분석 범위내 간격 (m)').onChange(refreshPreview);
  analysisFolder.add(settings, 'observerHeight', 0, 100, 0.1).name('관측자 높이 (m)');
  ui.analyzeBtn = gui.add(settings, 'analyze').name('분석 시작').disable();
}

function hideContextMenu() {
  ui.contextMenu.style.display = 'none';
}

function bindEvents() {
  const mapWrap = document.getElementById('map-wrap');

  // 우클릭: 화면 Point → 지도 좌표 변환 후 컨텍스트 메뉴 표시
  mapWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.target.closest('#gui')) return;
    const rect = mapWrap.getBoundingClientRect();
    const point = [e.clientX - rect.left, e.clientY - rect.top];
    const { lng, lat } = map.unproject(point);
    ui.contextMenu.dataset.lngLat = JSON.stringify([lng, lat]);
    ui.contextMenu.style.left = `${point[0]}px`;
    ui.contextMenu.style.top = `${point[1]}px`;
    ui.contextMenu.style.display = 'block';
  });
  ui.createMarkerBtn.addEventListener('click', () => {
    setReferencePoint(JSON.parse(ui.contextMenu.dataset.lngLat));
    hideContextMenu();
  });
  document.addEventListener('mousedown', (e) => {
    if (!ui.contextMenu.contains(e.target)) hideContextMenu();
  });

  map.on('render', renderOverlay); // 지도 페인트 직후 같은 프레임에 오버레이 렌더
  map.on('zoomend', () => { drawPreview(); renderOverlay(); }); // 미리보기 점 크기를 화면 px 기준으로 유지
  map.on('resize', renderOverlay);
  ui.clearLogBtn.addEventListener('click', () => (logEl.innerHTML = ''));
}

async function init() {
  buildGui();
  // autoStart: false → Pixi 자체 ticker 로 그리지 않고 지도 render 이벤트에서 직접 렌더
  // antialias 끔 + 해상도 상한 1.5: 고해상도 화면에서 매 프레임 합성 비용(MSAA·픽셀 수)을 줄인다. 테두리는 pixelLine 이라 영향 없음
  await pixi.init({
    resizeTo: document.getElementById('map-wrap'),
    backgroundAlpha: 0,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 1.5),
    powerPreference: 'high-performance',
    autoStart: false,
  });
  document.getElementById('overlay').appendChild(pixi.canvas);
  pixi.stage.addChild(layer);
  bindEvents();
  log('지도를 우클릭하여 기준점을 지정하세요.');
}

init();
