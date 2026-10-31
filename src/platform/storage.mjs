import { AppError } from './errors.mjs';

function keyFor(environment, area, id) {
  if (!['quarantine', 'review', 'release'].includes(area) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new AppError('INVALID_OBJECT_KEY', 400, '无效的对象标识');
  }
  return `${environment}/${area}/${id}`;
}

// Driver is server-only. Supplier implementation must enforce bucket ACL/IAM and
// private network access; no public URL or signed URL API exists in this boundary.
export function createPrivateStorage(config, driver = null) {
  const requireDriver = () => {
    if (!driver || !config.storage.bucket) throw new AppError('STORAGE_UNAVAILABLE', 503, '私有存储尚未就绪');
  };
  return Object.freeze({
    async health() {
      if (!driver || !config.storage.bucket) return false;
      return (await driver.checkPrivate({ bucket: config.storage.bucket })) === true;
    },
    async put(area, id, bytes) {
      const key = keyFor(config.environment, area, id);
      requireDriver();
      if (!(bytes instanceof Uint8Array)) throw new AppError('INVALID_OBJECT', 400, '对象必须是字节数据');
      await driver.put({ bucket: config.storage.bucket, key, bytes, visibility: 'private', ifAbsent: true });
      return key;
    },
    async get(area, id) {
      const key = keyFor(config.environment, area, id);
      requireDriver();
      return driver.get({ bucket: config.storage.bucket, key });
    },
  });
}
