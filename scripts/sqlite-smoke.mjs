import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const database = new DatabaseSync(':memory:');
try {
  database.exec('CREATE VIRTUAL TABLE notes USING fts5(body)');
  database.prepare('INSERT INTO notes (body) VALUES (?)').run('zorblax acme');
  const row = database.prepare('SELECT body FROM notes WHERE notes MATCH ?').get('zorblax');
  assert.equal(row?.body, 'zorblax acme');
  console.log('ok');
} finally {
  database.close();
}
