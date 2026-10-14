# Viewshed — MapLibre GL JS + Pixi.js

## 실행

```bash
npm run dev     # http://localhost:5500
```
## Skills

| 영역 | 기술 | 역할 |
|---|---|---|
| 지도 | [MapLibre GL JS 6](https://maplibre.org/) (ESM) | 지도, Project / UnProject |
| 오버레이 | [Pixi.js 8](https://pixijs.com/) (WebGL/WebGPU) | 가시화 |
| 고도 | [AWS Terrain Tiles (Terrarium)](https://registry.opendata.aws/terrain-tiles/) | - |
| 배경 지도 | OpenFreeMap (벡터), OSM, OpenTopoMap | - |
| UI | [lil-gui](https://lil-gui.georgealways.com/) | - |
| 계산 | Web Worker | Tile Decoding + Main thread 밖에서 계산 |


## 핵심 기술

### 1. MapLibre ↔ Pixi 동기화

도형은 **기준점을 원점으로 하는 Local Position** 으로 최초 생성. 지도가 움직이면 Pixi 레이어의 2D 행렬만 Update.

```js
// app.js
function syncOverlay() {
  const d = 1e-5;                                     // 메르카토르 단위 오프셋
  const o  = map.project(state.marker);               // 원점 → 화면 px
  const px = map.project(fromMercator([ox + d, oy])); // x축 방향 한 점
  const py = map.project(fromMercator([ox, oy + d])); // y축 방향 한 점
  const k = 1 / (d * CONFIG.localUnit);
  // 로컬 → 화면 affine 행렬 (배율·회전 포함). 부호 추정 없이 투영 결과로 직접 계산
  layer.setFromMatrix(new PIXI.Matrix((px.x-o.x)*k, (px.y-o.y)*k, (py.x-o.x)*k, (py.y-o.y)*k, o.x, o.y));
}
```

### 2. Pixi 렌더 직접 호출로 불필요한 렌더 작업 제거

PixiJS 자체 ticker 비활성(`autoStart: false`). MapLibre 가 매 프레임 지도 페인트 직후 발생시키는 `render` 이벤트 안에서 `pixi.render()` 직접 호출 → 동일 프레임, 지연 0.

```js
map.on('render', renderOverlay);
function renderOverlay() {
  syncOverlay();                     // 행렬이 이전과 같으면 needsUpdate 를 올리지 않음
  if (!state.needsUpdate) return;    // 뷰도 도형도 그대로면 스킵 (타일 로딩으로 오는 render 무시)
  pixi.render();
  state.needsUpdate = false;
}
```

### 3. LOS 분석 (Worker)

방위각별로 시선을 **DEM 해상도(≈15m) 간격**으로 촘촘히 따라가며 누적 최대 기울기 갱신. 링 지점 도달 시 기울기 ≥ 최대 기울기 → 가시, 미만 → 비가시. 표시 간격(링)과 분석 간격(샘플) 분리 → 링 사이 능선 누락 방지.

```js
// analysis.worker.js
const sampleStep = elevation.metersPerPixel(lat);          // DEM 1px ≈ 15m
samples = [촘촘한 간격 d] ∪ [링 거리] (오름차순, 링에는 번호 부여)
for (방위각 i) {
  let maxSlope = -Infinity;
  for ({ d, ring } of samples) {
    const h = elevation.getElevation(destination(marker, bearing, d)) - curvatureDrop(d);
    const slope = (h - eyeLevel) / d;
    if (ring) visible[i][ring - 1] = slope >= maxSlope;
    maxSlope = Math.max(maxSlope, slope);
  }
}
```

정밀도 보정 3종
- **조밀 샘플링**: 분석 간격 = DEM 픽셀 크기. 사용자 설정 "범위내 간격"은 표시 단위
- **쌍선형 보간**: 픽셀 4개 가중 평균 → 계단 현상 제거 (`elevation.js › getElevation`)
- **곡률 · 굴절 보정**: `drop = (1 − k)·d² / 2R`, k = 0.13, R = 6,371 km. 10 km 에서 ≈ 6.8 m

고도 디코딩: Terrarium PNG → `OffscreenCanvas` → `h = R·256 + G + B/256 − 32768`

### 4. 가시화 — 결과 1회 빌드

분석 결과 수신 → 셀 전체를 Graphics 에 한 번에 빌드 → 1회 렌더. 셀 = 반투명 채움 + 동색 불투명 1px 테두리(`pixelLine`).

```js
buildResult(s, visible);   // 모든 셀 1회 빌드
renderOverlay();           // 1회 렌더. 이후 뷰 변경은 행렬 갱신만
```

시도 후 폐기: 프레임별 셀 추가(Graphics 전체 재빌드 → O(n²)), 마스크 확장 애니메이션(스텐실 패스 + 매 프레임 렌더 → 체감 지연). 정적 결과에는 1회 빌드가 가장 빠름.

### 5. 캐싱

| 단계 | 위치 | 절약 대상 |
|---|---|---|
| 고도 타일 | 워커 | 네트워크 |
| 꼭짓점 격자 `getGrid()` | 메인 | 삼각함수 (셀이 꼭짓점을 공유) |
| 분석 결과 `analyzeCached()` | 메인 | 계산 자체 (같은 기준점·설정, 최근 20건) |

## 한계

- pitch 미지원 (2D affine 동기화)
- DEM 해상도 15m · 지표면 모델(DSM 아님) → 건물 · 수목 미반영
- 방위각 사이(셀 폭)는 중심 방향 1개로 대표
- 거리 계산 equirectangular 근사 (수 km 범위 전제)

## 사용법

1. 지도 우클릭 → **기준점 지정**
2. 우상단 설정에서 범위 / 분석 방위각 개수 / 분석 범위내 간격 / 관측자 높이 조정 → 검정 미리보기가 즉시 반영
3. **분석 시작** → 하단 로그에 타일 로드·진행률 표시 → 완료 후 안쪽부터 가시화 (초록 = 가시, 빨강 = 비가시)
4. 새 기준점을 지정하면 이전 결과는 제거
