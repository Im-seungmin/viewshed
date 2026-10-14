/**
 * .env (또는 배포 환경의 process.env) 에서 브라우저용 env.js 를 생성한다.
 *   로컬 : node scripts/build-env.js   (.env 수정 후 1회 실행)
 *   Vercel: vercel.json 의 buildCommand 로 자동 실행 (키는 Vercel 환경 변수에 등록)
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_KEYS = ['MAPTILER_KEY', 'CARTO_KEY']; // 브라우저에 노출해도 되는 키만
const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');

// .env 파일이 있으면 읽어서 process.env 에 병합 (이미 있는 값은 유지)
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = Object.fromEntries(PUBLIC_KEYS.map((k) => [k, process.env[k] ?? '']));
fs.writeFileSync(path.join(root, 'env.js'), `// 자동 생성 파일 (scripts/build-env.js) - 직접 수정하지 말 것\nwindow.ENV = ${JSON.stringify(env, null, 2)};\n`);
console.log('env.js 생성:', Object.keys(env).map((k) => `${k}=${env[k] ? '(설정됨)' : '(없음)'}`).join(', '));
