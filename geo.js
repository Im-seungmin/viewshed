/** 지리 좌표 유틸 (메인 스레드·워커 공용) */

export const toRad = (deg) => (deg * Math.PI) / 180;

/** 시작점에서 방위각(deg)·거리(m) 만큼 떨어진 지점 (equirectangular 근사) */
export function destination([lng, lat], bearingDeg, distanceM) {
  const b = toRad(bearingDeg);
  const dLat = (distanceM * Math.cos(b)) / 111320;
  const dLng = (distanceM * Math.sin(b)) / (111320 * Math.cos(toRad(lat)));
  return [lng + dLng, lat + dLat];
}

/** 경위도 → 웹 메르카토르 (0~1) */
export function toMercator([lng, lat]) {
  const x = (lng + 180) / 360;
  const sin = Math.sin(toRad(lat));
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return [x, y];
}

/** 웹 메르카토르 (0~1) → 경위도 */
export function fromMercator([x, y]) {
  const lng = x * 360 - 180;
  const lat = (Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) * 2 - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}

/**
 * 분석 설정 정규화. 범위가 간격으로 나누어떨어지지 않아도 마지막 링은 범위 끝까지 포함한다.
 * @returns {{ range, azimuthCount, interval, observerHeight, ringCount, ringDistances: number[] }}
 *   ringDistances[k] = k번째 링의 중심으로부터 거리 (k = 0..ringCount)
 */
export function normalizeSettings({ range, azimuthCount, interval, observerHeight }) {
  range = Math.max(10, range);
  azimuthCount = Math.max(3, Math.floor(azimuthCount));
  interval = Math.min(range, Math.max(1, interval));
  const ringCount = Math.ceil(range / interval - 1e-9);
  const ringDistances = Array.from({ length: ringCount + 1 }, (_, k) => Math.min(k * interval, range));
  return { range, azimuthCount, interval, observerHeight, ringCount, ringDistances };
}
