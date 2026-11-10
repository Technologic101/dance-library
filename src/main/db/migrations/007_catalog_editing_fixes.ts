import type { Migration } from '../migrate';
import { builtinStyleId } from '../../../shared/builtinStyles';
import { installCatalogSearchTriggers } from '../searchIndex';

const addedStyles = ['Kizomba Fusion', 'Salsa On1', 'Salsa On2', 'Brazilian Zouk', 'Zouk Lambada'];

/** Upgrade-safe Phase 3 corrections. Migration 005 remains an immutable Phase 2 snapshot. */
export const migration007: Migration = {
  id: 7,
  name: '007_catalog_editing_fixes',
  up(db) {
    const existing = db.prepare('SELECT id FROM styles WHERE name=? COLLATE NOCASE');
    const insert = db.prepare(
      `INSERT INTO styles(id,name,builtin,created_at) VALUES(?,?,1,'2024-01-01T00:00:00.000Z')`,
    );
    for (const name of addedStyles) if (!existing.get(name)) insert.run(builtinStyleId(name), name);
    installCatalogSearchTriggers(db);
  },
};
