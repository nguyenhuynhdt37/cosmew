import type { Database } from 'bun:sqlite';
import { FutrynError } from '@futryn/contracts';

/** Serializes rotating credential use across CLI processes. Dead-process claims
 * are reclaimed inside the same SQLite transaction; no time-based takeover can
 * race an active vault write. PID reuse fails closed. */
export class RuntimeLeases {
  constructor(private readonly db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS runtime_leases (account TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)');
  }
  acquire(accountId: string): string {
    const owner = crypto.randomUUID();
    this.db.transaction(() => {
      const existing = this.db.query('SELECT owner,pid FROM runtime_leases WHERE account=?').get(accountId) as {owner:string;pid:number} | null;
      if (existing) {
        let alive = true;
        try { process.kill(existing.pid, 0); } catch (error) { alive = (error as {code?:string}).code !== 'ESRCH'; }
        if (alive) throw new FutrynError('POLICY');
        this.db.query('DELETE FROM runtime_leases WHERE account=? AND owner=?').run(accountId, existing.owner);
      }
      this.db.query('INSERT INTO runtime_leases VALUES(?,?,?)').run(accountId, owner, process.pid);
    }).immediate();
    return owner;
  }
  release(accountId: string, owner: string): void {
    this.db.query('DELETE FROM runtime_leases WHERE account=? AND owner=?').run(accountId, owner);
  }
}
