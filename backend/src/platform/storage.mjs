import { AppError } from './errors.mjs';

const objectAreas = ['quarantine', 'review', 'release'];
const localAreas = ['incoming', 'quarantine', 'review', 'release', 'serving'];

function keyFor(environment, area, id, areas) {
  if (!areas.includes(area) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new AppError('INVALID_OBJECT_KEY', 400, '无效的对象标识');
  }
  return `${environment}/${area}/${id}`;
}

// Driver is server-only. Supplier implementation must enforce bucket ACL/IAM and
// private network access; no public URL or signed URL API exists in this boundary.
export function createPrivateStorage(config, driver = null) {
  const local = config.storage?.driver === 'local';
  const areas = local ? localAreas : objectAreas;
  const namespace = local ? config.storage?.root : config.storage?.bucket;
  const requireDriver = () => {
    if (!driver || !namespace) throw new AppError('STORAGE_UNAVAILABLE', 503, '私有存储尚未就绪');
  };
  return Object.freeze({
    async health() {
      if (!driver || !namespace) return false;
      return (await driver.checkPrivate({ bucket: config.storage.bucket, root: config.storage.root, driver: config.storage.driver })) === true;
    },
    async put(area, id, bytes) {
      const key = keyFor(config.environment, area, id, areas);
      requireDriver();
      if (!(bytes instanceof Uint8Array)) throw new AppError('INVALID_OBJECT', 400, '对象必须是字节数据');
      await driver.put({ bucket: config.storage.bucket, root: config.storage.root, key, bytes, visibility: 'private', ifAbsent: true });
      return key;
    },
    async get(area, id, expected = null) {
      const key = keyFor(config.environment, area, id, areas);
      requireDriver();
      // Optional expected size/digest reuses platform.game_versions.digest (005)
      // without any database schema change; the driver always verifies its own
      // sidecar digest even when no expected value is supplied.
      return driver.get({ bucket: config.storage.bucket, root: config.storage.root, key,
        expectedDigest: expected?.digest ?? null, expectedSize: expected?.size ?? null });
    },
  });
}
