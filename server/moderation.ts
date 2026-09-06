// Words that never belong on a map, plus the shared contact-details check.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleError, checkText } from '../shared/rules';

const here = path.dirname(fileURLToPath(import.meta.url));
const words = readFileSync(path.join(here, 'blocklist.txt'), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
const pattern = words.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu') : null;

/** Throws a RuleError for abusive words or contact details. `what` names the field in the message. */
export function moderate(text: string | null | undefined, what = 'That'): void {
  if (!text) return;
  checkText(text, what);
  const t = text.normalize('NFKC').replace(/[​-‍﻿]/g, '');
  if (pattern && pattern.test(t)) throw new RuleError(`${what} contains a word that is not allowed on the map.`);
}
export const blockedWordCount = words.length;
