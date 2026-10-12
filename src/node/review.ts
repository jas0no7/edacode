export interface ReviewLine { text: string; kind: 'add' | 'remove' | 'context' | 'hunk'; old?: number; next?: number }
/** 保留整个 unified diff；行号分别沿旧文件和新文件递增。 */
export function reviewLines(diff: string): ReviewLine[] {
  const rows: ReviewLine[] = []; let old = 0, next = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; rows.push({text: line, kind: 'hunk'}); continue; }
    if (!inHunk) continue;
    if (line.startsWith('-')) rows.push({text: line.slice(1), kind: 'remove', old: old++});
    else if (line.startsWith('+')) rows.push({text: line.slice(1), kind: 'add', next: next++});
    else if (line.startsWith(' ')) rows.push({text: line.slice(1), kind: 'context', old: old++, next: next++});
    else if (line) rows.push({text: line, kind: 'hunk'});
  }
  return rows.length ? rows : diff.split('\n').map(text => ({text, kind: 'context'}));
}
