import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import logger from './logger.ts';

/**
 * 基于 SQLite 的持久化存储 (对标 mimo-free-api)
 */
class SQLiteStorage {
    private db: any;
    private readonly MAX_ENTRIES = 10000; // 🌟 限制最大条目数

    constructor() {
        const dbPath = path.join(process.cwd(), 'data', 'sessions.db');
        fs.ensureDirSync(path.dirname(dbPath));

        this.db = new Database(dbPath);
        this.init();
    }

    private init() {
        // 🌟 统一使用 kv_config，移除未使用的 session_index
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kv_config (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER
            )
        `);
        // 创建索引加速清理
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_updated_at ON kv_config(updated_at)`);

        logger.info('[STORAGE] SQLite database initialized (better-sqlite3).');
    }

    public get(key: string): any {
        const row = this.db.prepare('SELECT value FROM kv_config WHERE key = ?').get(key) as any;
        if (row) {
            try { return JSON.parse(row.value); } catch { return row.value; }
        }
        return undefined;
    }

    public set(key: string, value: any) {
        const valStr = typeof value === 'string' ? value : JSON.stringify(value);
        const now = Date.now();
        
        // 🌟 检查容量，若超出则清理最旧的一批
        const count = (this.db.prepare('SELECT COUNT(*) as count FROM kv_config').get() as any).count;
        if (count >= this.MAX_ENTRIES) {
            this.db.prepare('DELETE FROM kv_config WHERE key IN (SELECT key FROM kv_config ORDER BY updated_at ASC LIMIT 100)').run();
        }

        this.db.prepare('INSERT OR REPLACE INTO kv_config (key, value, updated_at) VALUES (?, ?, ?)').run(key, valStr, now);
    }

    public has(key: string): boolean {
        const row = this.db.prepare('SELECT 1 FROM kv_config WHERE key = ?').get(key);
        return !!row;
    }

    public delete(key: string) {
        this.db.prepare('DELETE FROM kv_config WHERE key = ?').run(key);
    }

    public cleanup(ttlMs: number) {
        const threshold = Date.now() - ttlMs;
                const result = this.db.prepare(`
                        DELETE FROM kv_config
                        WHERE updated_at < ?
                            AND (
                                key LIKE 'session:%'
                                OR key LIKE 'chat:%'
                                OR key LIKE 'messages:%'
                                OR key LIKE 'responses:%'
                            )
                `).run(threshold);
        if (result.changes > 0) {
            logger.info(`[STORAGE] Cleaned up ${result.changes} expired sessions.`);
            this.db.exec('VACUUM'); // 定期收缩数据库文件
        }
    }
}

export const storage = new SQLiteStorage();
export default storage;
