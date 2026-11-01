import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import {
  parseFile, setFields, sectionRange, appendToSection, replaceBody, setAcceptance,
} from '../core/frontmatter.mjs';
import { rng, genDocument, genOps } from './support/gen.mjs';

function editRange(text, parsed, key) {
  const yaml = text.slice(parsed.yamlStart, parsed.yamlEnd);
  const pairs = parseDocument(yaml).contents?.items ?? [];
  const index = pairs.findIndex((pair) => pair.key.value === key);
  if (index < 0) return [parsed.yamlEnd, parsed.yamlEnd];
  const pair = pairs[index];
  const start = yaml.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
  const end = index + 1 < pairs.length
    ? yaml.lastIndexOf('\n', pairs[index + 1].key.range[0] - 1) + 1 : yaml.length;
  return [parsed.yamlStart + start, parsed.yamlStart + end];
}

test('500 seeds preserve valid YAML, unrelated fields and bytes outside each edit', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    let text = genDocument(r);
    let step = 0;
    try {
      for (const op of genOps(r, 20)) {
        const before = parseFile(text);
        assert.equal(before.error, null);
        assert.equal(before.editable, true);
        let result;
        let range;
        if (op.kind === 'fields') {
          const key = Object.keys(op.patch)[0];
          range = editRange(text, before, key);
          result = setFields(text, op.patch);
          const after = parseFile(result);
          for (const [other, value] of Object.entries(before.data)) {
            if (other !== key) assert.deepEqual(after.data[other], value);
          }
          if (op.patch[key] === undefined) assert.equal(Object.hasOwn(after.data, key), false);
          else assert.deepEqual(after.data[key], op.patch[key]);
          assert.equal(after.body, before.body);
        } else if (op.kind === 'acceptance') {
          result = setAcceptance(text, op.n, op.checked);
          const differences = [];
          assert.equal(result.length, text.length);
          for (let i = 0; i < text.length; i++) if (text[i] !== result[i]) differences.push(i);
          assert.ok(differences.length <= 1);
          if (differences.length) {
            assert.match(text.slice(differences[0] - 1, differences[0] + 2), /^\[[ x]\]$/);
          }
          range = [before.bodyStart, text.length];
        } else if (op.kind === 'append') {
          const section = sectionRange(text, op.heading);
          range = [section[1], section[1]];
          result = appendToSection(text, op.heading, op.lines);
        } else {
          range = [before.bodyStart, text.length];
          result = replaceBody(text, before.body + op.suffix);
        }
        const after = parseFile(result);
        assert.equal(after.error, null);
        assert.equal(after.eol, before.eol);
        assert.equal(after.bom, before.bom);
        assert.equal(result.slice(0, range[0]), text.slice(0, range[0]));
        assert.ok(result.endsWith(text.slice(range[1])));
        if (op.kind !== 'fields') assert.deepEqual(after.data, before.data);
        text = result;
        step++;
      }
    } catch (error) {
      error.message = `seed=${seed}, step=${step}: ${error.message}`;
      throw error;
    }
  }
});
