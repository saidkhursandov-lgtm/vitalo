import { assertDevOrTestDatabase, dbTarget, describeDb } from './db-target';

describe('database target of CLI scripts', () => {
  it('reads host, port and name, never the password', () => {
    const t = dbTarget('postgresql://vitalo:s3cret@localhost:5432/vitalo_dev');
    expect(t).toEqual({ host: 'localhost', port: '5432', database: 'vitalo_dev', socket: false });
    expect(describeDb(t)).toBe('«vitalo_dev» на localhost:5432');
    expect(describeDb(t)).not.toContain('s3cret');
  });

  it('understands the production socket form', () => {
    const t = dbTarget('postgresql://vitalo@localhost/vitalo?host=/var/run/postgresql');
    expect(t).toMatchObject({ host: '/var/run/postgresql', database: 'vitalo', socket: true });
    expect(describeDb(t)).toBe('«vitalo» (сокет /var/run/postgresql)');
  });

  it('dev/test scripts accept only *_dev and *_test databases outside production', () => {
    const url = (db: string) => `postgresql://u:p@localhost:5432/${db}`;
    expect(assertDevOrTestDatabase('seed', { DATABASE_URL: url('vitalo_dev') }).database).toBe('vitalo_dev');
    expect(assertDevOrTestDatabase('seed', { DATABASE_URL: url('vitalo_test') }).database).toBe('vitalo_test');
    expect(() => assertDevOrTestDatabase('seed', { DATABASE_URL: url('vitalo') })).toThrow(/только базы, чьё имя оканчивается на _dev или _test/);
    expect(() => assertDevOrTestDatabase('seed', { DATABASE_URL: url('vitalo_devx') })).toThrow();
    expect(() => assertDevOrTestDatabase('seed', { DATABASE_URL: url('vitalo_dev'), NODE_ENV: 'production' })).toThrow(/refuses NODE_ENV=production/);
    expect(() => assertDevOrTestDatabase('seed', {})).toThrow(/DATABASE_URL is empty/);
  });
});
