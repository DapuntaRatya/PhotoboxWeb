const storage = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('photobox-draft', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('images');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export class Draft {
  private db = storage();
  readonly blobs = new Map<string, Blob>();
  private pending = new Map<string, Promise<Blob | undefined>>();

  constructor(private room: string) { void this.db.catch(() => {}); }

  get(id: string) {
    if (this.blobs.has(id)) return Promise.resolve(this.blobs.get(id));
    const existing = this.pending.get(id);
    if (existing) return existing;
    const read = this.db.then((db) => new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(`${this.room}/${id}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })).then((blob) => {
      if (blob && !this.blobs.has(id)) this.blobs.set(id, blob);
      return this.blobs.get(id);
    }).catch(() => undefined).finally(() => this.pending.delete(id));
    this.pending.set(id, read);
    return read;
  }

  async put(id: string, blob: Blob) {
    this.blobs.set(id, blob);
    const db = await this.db;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put(blob, `${this.room}/${id}`);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  remove(id: string) {
    this.blobs.delete(id);
    void this.db.then((db) => db.transaction('images', 'readwrite').objectStore('images').delete(`${this.room}/${id}`)).catch(() => {});
  }

  prune(ids: Set<string>) {
    for (const id of this.blobs.keys()) if (!ids.has(id)) this.blobs.delete(id);
    void this.db.then((db) => {
      const prefix = `${this.room}/`;
      const store = db.transaction('images', 'readwrite').objectStore('images');
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!ids.has(String(cursor.key).slice(prefix.length))) cursor.delete();
        cursor.continue();
      };
    }).catch(() => {});
  }

  close() { void this.db.then((db) => db.close()).catch(() => {}); }
}
