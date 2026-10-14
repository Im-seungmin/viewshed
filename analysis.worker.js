/**
 * 가시선 분석 워커. 타일 디코딩과 계산을 메인 스레드 밖에서 수행한다.
 *
 * 수신: { type: 'analyze', id, marker: [lng, lat], settings }  (settings 는 geo.normalizeSettings 결과)
 * 송신: { type: 'tiles', id, done, total }
 *       { type: 'progress', id, done, total }
 *       { type: 'result', id, observerElevation, sampleStep, visible: boolean[][] }   visible[i][k-1]
 *       { type: 'error', id, message }
 */
import { destination } from './geo.js';
import { ElevationProvider } from './elevation.js';

const ELEVATION_ZOOM = 13; // ≈ 15m/px @ 한국
const EARTH_RADIUS = 6371000; // m
const REFRACTION_K = 0.13; // 대기 굴절 계수 (측량 관례값)

/** 지구 곡률 + 대기 굴절에 의한 겉보기 고도 하락 (m). 거리 d 에서 지표가 시선 아래로 내려가는 양 */
const curvatureDrop = (d) => ((1 - REFRACTION_K) * d * d) / (2 * EARTH_RADIUS);
const elevation = new ElevationProvider(ELEVATION_ZOOM); // 워커가 살아있는 동안 타일 캐시 유지
let currentId = 0; // 더 새로운 요청이 오면 진행 중인 분석은 중단

const yieldToMessages = () => new Promise((r) => setTimeout(r)); // 취소 메시지를 받을 틈을 준다

/**
 * 각 방위각마다 시선을 DEM 해상도 간격으로 촘촘히 따라가며 누적 최대 기울기를 갱신한다.
 * 링 지점에 도달할 때마다 그 지점의 기울기가 최대 기울기 이상이면 보임(visible), 미만이면 가려짐(hidden).
 * 표시 간격(링)과 분석 간격(샘플)을 분리해 링 사이 능선을 놓치지 않는다.
 */
async function analyze(id, marker, settings) {
  const { range, azimuthCount, observerHeight, ringCount, ringDistances } = settings;

  await elevation.preload(marker, range, (done, total) => postMessage({ type: 'tiles', id, done, total }));
  if (id !== currentId) return;

  const observerElevation = elevation.getElevation(marker);
  const eyeLevel = observerElevation + observerHeight;
  const sampleStep = Math.max(1, elevation.metersPerPixel(marker[1])); // DEM 1픽셀마다 샘플
  const total = azimuthCount * ringCount;
  const visible = [];

  // 샘플 지점 거리 목록: 촘촘한 간격 ∪ 링 거리 (오름차순). 링 거리에는 ring 번호를 붙인다
  const samples = [];
  for (let d = sampleStep; d < range; d += sampleStep) samples.push({ d, ring: 0 });
  for (let k = 1; k <= ringCount; k++) samples.push({ d: ringDistances[k], ring: k });
  samples.sort((a, b) => a.d - b.d);

  for (let i = 0; i < azimuthCount; i++) {
    const bearing = (i * 360) / azimuthCount;
    let maxSlope = -Infinity;
    visible[i] = [];
    for (const { d, ring } of samples) {
      const h = elevation.getElevation(destination(marker, bearing, d)) - curvatureDrop(d);
      const slope = (h - eyeLevel) / d;
      if (ring) visible[i][ring - 1] = slope >= maxSlope;
      maxSlope = Math.max(maxSlope, slope);
    }
    postMessage({ type: 'progress', id, done: (i + 1) * ringCount, total });
    await yieldToMessages();
    if (id !== currentId) return;
  }
  postMessage({ type: 'result', id, observerElevation, sampleStep, visible });
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'analyze') return;
  currentId = data.id;
  try {
    await analyze(data.id, data.marker, data.settings);
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: err.message });
  }
};
