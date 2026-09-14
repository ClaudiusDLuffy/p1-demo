// Minimal SQL statement splitter for the repository's dollar-quoted migrations.
// Shared lifecycle fixtures accept this parser without changing their files.
export function migrationStatements(sql) {
  const parts = [];
  let start = 0, quote = '', dollar = '', block = 0, line = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index], next = sql[index + 1];
    if (line) { if (character === '\n') line = false; continue; }
    if (block) {
      if (character === '/' && next === '*') { block++; index++; }
      else if (character === '*' && next === '/') { block--; index++; }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, index)) { index += dollar.length - 1; dollar = ''; }
      continue;
    }
    if (quote) {
      if (character === quote) { if (next === quote) index++; else quote = ''; }
      continue;
    }
    if (character === '-' && next === '-') { line = true; index++; continue; }
    if (character === '/' && next === '*') { block = 1; index++; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '$') {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
      if (tag) { dollar = tag; index += tag.length - 1; continue; }
    }
    if (character === ';') { parts.push(sql.slice(start, index + 1)); start = index + 1; }
  }
  if (sql.slice(start).trim()) parts.push(sql.slice(start));
  return parts;
}
