// オフラインでも起動できるように、アプリ本体のファイルをキャッシュする
importScripts('./js/version.js', './js/assets.js');
const CACHE_PREFIX = 'jinbutsuroku-cache-';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const VERSION_URL = new URL('./js/version.js', self.location.href).href;

// このバージョンのファイル一式がキャッシュにそろっているか
async function cacheIsComplete(cache) {
  const ver = await cache.match(VERSION_URL);
  if (!ver || !(await ver.text()).includes(`'${APP_VERSION}'`)) return false;
  const hits = await Promise.all(CORE_ASSETS.map((u) => cache.match(new URL(u, self.location.href).href)));
  return hits.every(Boolean);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 画面側の自動更新ですでに入れてあれば取り直さない(配信キャッシュの古いファイルで上書きしないため)
    if (await cacheIsComplete(cache)) return;
    // 取れなかったり古いファイルしか返らなかったりしたら、インストールを失敗させて今の版を使い続ける
    // (空のキャッシュのまま切り替わって、前の版のキャッシュまで消すことがないように)
    const entries = await fetchFreshAssets(APP_VERSION);
    await Promise.all(entries.map(([href, res]) => cache.put(href, res)));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // 新しい版のキャッシュ(画面側が先に用意したもの)は消さない
      Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && Number(k.slice(CACHE_PREFIX.length)) < Number(APP_VERSION)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // バージョン確認や最新ファイルの取得(URLに目印つき)は、いつもサーバーに取りに行く
  if (url.search) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
