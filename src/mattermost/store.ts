import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandHandler } from '../commands/router.ts';
import type { Post } from './client.ts';

export interface Delivery {
  delivery_id: string;
  source_id: string;
  source_at: number;
  message: string;
  attempts: number;
}

export class TransportStore {
  private readonly db: DatabaseSync;
  private readonly scope: string;

  constructor(db: DatabaseSync, scope: string) {
    this.db = db;
    this.scope = scope;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mm_sync (
        scope TEXT PRIMARY KEY, cursor_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mm_receipts (
        scope TEXT NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY (scope, source_id)
      );
      CREATE TABLE IF NOT EXISTS mm_outbox (
        scope TEXT NOT NULL, delivery_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_at INTEGER NOT NULL,
        message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        sent_id TEXT,
        PRIMARY KEY (scope, delivery_id), UNIQUE (scope, source_id)
      );
    `);
  }

  cursor(): number | undefined {
    const row = this.db.prepare('SELECT cursor_at FROM mm_sync WHERE scope = ?').get(this.scope);
    return row ? Number(row.cursor_at) : undefined;
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  initialize(posts: Post[]): void {
    this.transaction(() => {
      if (this.cursor() !== undefined) return;
      for (const post of posts) this.ignore(post.id);
      this.db.prepare('INSERT INTO mm_sync (scope, cursor_at) VALUES (?, ?)')
        .run(this.scope, posts.reduce((time, post) => Math.max(time, post.create_at), 0));
    });
  }

  private ignore(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO mm_receipts (scope, source_id) VALUES (?, ?)').run(this.scope, id);
  }

  isSentPost(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM mm_outbox WHERE scope = ? AND sent_id = ?').get(this.scope, id));
  }

  accept(post: Post, handler: CommandHandler): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM mm_receipts WHERE scope = ? AND source_id = ?').get(this.scope, post.id)) return;
      const message = handler(post.message, post.id);
      if (message !== null) {
        this.db.prepare(`INSERT INTO mm_outbox (scope, delivery_id, source_id, source_at, message)
          VALUES (?, ?, ?, ?, ?)`).run(this.scope, randomUUID(), post.id, post.create_at, message);
      }
      this.ignore(post.id);
    });
  }

  checkpoint(time: number): void {
    this.db.prepare('UPDATE mm_sync SET cursor_at = MAX(cursor_at, ?) WHERE scope = ?').run(time, this.scope);
  }

  pending(): Delivery[] {
    return this.db.prepare(`SELECT delivery_id, source_id, source_at, message, attempts
      FROM mm_outbox WHERE scope = ? AND sent_id IS NULL ORDER BY source_at, source_id`)
      .all(this.scope) as unknown as Delivery[];
  }

  attempted(deliveryId: string): void {
    this.db.prepare('UPDATE mm_outbox SET attempts = attempts + 1 WHERE scope = ? AND delivery_id = ?')
      .run(this.scope, deliveryId);
  }

  sent(deliveryId: string, postId: string): void {
    this.db.prepare('UPDATE mm_outbox SET sent_id = ? WHERE scope = ? AND delivery_id = ?')
      .run(postId, this.scope, deliveryId);
  }
}
