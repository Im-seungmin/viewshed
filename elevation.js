/** AWS Terrarium 고도 타일 (무료, 키 불필요) — PNG 를 디코딩해 픽셀 단위로 고도를 조회한다. */
import { destination, toMercator } from './geo.js';

const TILE_SIZE = 256;
const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export class ElevationProvider {
  constructor(zoom) {
    this.zoom = zoom;
    this.tiles = new Map(); // key: "x/y" → Uint8ClampedArray(RGBA). 인스턴스가 살아있는 동안 캐시 유지
  }

  /** 경위도 → (타일 x, 타일 y, 타일 내 실수 픽셀 fx, fy) */
  locate([lng, lat]) {
    const [mx, my] = toMercator([lng, lat]);
    const n = 2 ** this.zoom;
    const gx = mx * n, gy = my * n;
    const tx = Math.floor(gx), ty = Math.floor(gy);
    return { tx, ty, fx: (gx - tx) * TILE_SIZE - 0.5, fy: (gy - ty) * TILE_SIZE - 0.5 }; // 픽셀 중심 기준
  }

  /** 현재 줌·위도에서 1픽셀이 몇 m 인지 (분석 샘플 간격 결정용) */
  metersPerPixel(lat) {
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** this.zoom);
  }

  async loadTile(tx, ty) {
    const key = `${tx}/${ty}`;
    if (this.tiles.has(key)) return;
    const url = TERRARIUM_URL.replace('{z}', this.zoom).replace('{x}', tx).replace('{y}', ty);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`고도 타일 로드 실패 (${key}, HTTP ${res.status})`);
    const bitmap = await createImageBitmap(await res.blob());
    const ctx = new OffscreenCanvas(TILE_SIZE, TILE_SIZE).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    this.tiles.set(key, ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data);
  }

  /** 중심·반경(m) 을 덮는 모든 타일을 미리 로드한다 (캐시된 타일은 건너뜀). onProgress(done, total) */
  async preload(center, radiusM, onProgress) {
    const corners = [45, 135, 225, 315].map((b) => this.locate(destination(center, b, radiusM * Math.SQRT2)));
    const xs = corners.map((c) => c.tx), ys = corners.map((c) => c.ty);
    const keys = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++)
      for (let y = Math.min(...ys); y <= Math.max(...ys); y++) keys.push([x, y]);

    let done = 0;
    await Promise.all(keys.map(async ([x, y]) => {
      await this.loadTile(x, y);
      onProgress(++done, keys.length);
    }));
  }

  /** 타일 내 정수 픽셀 고도 (타일 경계는 클램프) */
  pixel(data, px, py) {
    const x = Math.min(TILE_SIZE - 1, Math.max(0, px));
    const y = Math.min(TILE_SIZE - 1, Math.max(0, py));
    const i = (y * TILE_SIZE + x) * 4;
    return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
  }

  /** 고도(m), 쌍선형 보간. preload 된 영역만 동기 조회 가능 */
  getElevation(lngLat) {
    const { tx, ty, fx, fy } = this.locate(lngLat);
    const data = this.tiles.get(`${tx}/${ty}`);
    if (!data) throw new Error('로드되지 않은 타일 영역입니다.');
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const sx = fx - x0, sy = fy - y0;
    const top = this.pixel(data, x0, y0) * (1 - sx) + this.pixel(data, x0 + 1, y0) * sx;
    const bottom = this.pixel(data, x0, y0 + 1) * (1 - sx) + this.pixel(data, x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  }
}
