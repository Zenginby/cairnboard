import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneColumns } from '../src/components/board-lanes.mjs';

const labels = { todo: 'Yapılacak', doing: 'Sürüyor', done: 'Bitti' };
const column = (key, role, cards, total = cards.length) => ({ key, label: `L-${key}`, role, total,
  cards: cards.map((id) => ({ id })) });

test('laneColumns merges columns that share a role, orders lanes to do, doing, done, keeps single ones', () => {
  const doing = column('doing', 'doing', ['a']);
  const done = column('done', 'done', ['e'], 60);
  const lanes = laneColumns([
    doing,
    column('waiting', 'todo', ['b']),
    column('next', 'todo', ['c', 'd']),
    column('review', 'doing', []),
    done,
  ], labels);

  assert.deepEqual(lanes.map((lane) => lane.key), ['todo', 'doing', 'done']);
  const [todoLane, doingLane, doneLane] = lanes;
  assert.equal(doneLane, done, 'a role with one column keeps that column object');
  assert.equal(doingLane.label, 'Sürüyor');
  assert.equal(doingLane.addKey, 'doing');
  assert.deepEqual(doingLane.cards, [{ id: 'a', columnLabel: 'L-doing' }]);
  assert.equal(todoLane.label, 'Yapılacak');
  assert.equal(todoLane.addKey, 'waiting', 'new cards go to the first column of the lane');
  assert.equal(todoLane.total, 3);
  assert.deepEqual(todoLane.cards.map((card) => [card.id, card.columnLabel]),
    [['b', 'L-waiting'], ['c', 'L-next'], ['d', 'L-next']]);
});

test('laneColumns leaves a board with one column per role unchanged', () => {
  const columns = [column('todo', 'todo', ['a']), column('doing', 'doing', []), column('done', 'done', ['b'])];
  assert.deepEqual(laneColumns(columns, labels), columns);
});
