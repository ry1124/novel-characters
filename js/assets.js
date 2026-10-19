// オフライン用にキャッシュするアプリ本体のファイル(service-worker.js と自動更新の両方で使う)
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/version.js',
  './js/assets.js',
  './js/db.js',
  './js/backup.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// サーバー上の最新のファイル一式を取る(画面側の自動更新と service-worker.js の両方で使う)。
// GitHub Pages は同じURLのファイルを最大10分キャッシュして配るので、公開直後は古いファイルが返ることがある。
// URLに毎回違う目印を付けて配信キャッシュを素通りさせ、取った version.js が version になっているかを確かめる。
// 戻り値は [目印なしのURL, レスポンス] の一覧(キャッシュには目印なしのURLで入れる)
async function fetchFreshAssets(version) {
  const stamp = `v=${encodeURIComponent(version)}&t=${Date.now()}`;
  const entries = await Promise.all(CORE_ASSETS.map(async (u) => {
    const href = new URL(u, self.location.href).href;
    const res = await fetch(`${href}${href.includes('?') ? '&' : '?'}${stamp}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${u} を取得できませんでした（${res.status}）`);
    return [href, res];
  }));
  const ver = entries.find(([href]) => href.endsWith('/js/version.js'));
  const text = await ver[1].clone().text();
  if (!text.includes(`'${version}'`)) throw new Error(`サーバーのファイルがまだ ${version} になっていません`);
  return entries;
}
