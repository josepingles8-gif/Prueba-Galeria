// IndexedDB storage: items, albums, meta
let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('galeria', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('albums', { keyPath: 'name' });
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
export const getItems = () => run('items', 'readonly', s => s.getAll());
export const getAlbums = () => run('albums', 'readonly', s => s.getAll());
export const putAlbum = a => run('albums', 'readwrite', s => s.put(a));
export const deleteAlbum = n => run('albums', 'readwrite', s => s.delete(n));
export const getMeta = k => run('meta', 'readonly', s => s.get(k)).then(r => r && r.value);
export const setMeta = (key, value) => run('meta', 'readwrite', s => s.put({ key, value }));
export async function putItems(arr) {
  await run('items', 'readwrite', s => {
    arr.forEach(it => {
      if (it.id == null) delete it.id;
      const r = s.put(it);
      r.onsuccess = () => { it.id = r.result; };
    });
  });
  return arr;
}
export const putItem = async it => (await putItems([it]))[0].id;
export const deleteItems = ids => run('items', 'readwrite', s => { ids.forEach(i => s.delete(i)); });
