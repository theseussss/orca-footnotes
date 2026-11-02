/** HTML textareas display CR/CRLF as LF. Rendering or merely closing one must
 * not silently rewrite a stored quotation's original line endings. */
export const nativeFieldDisplay = (raw: string): string => raw.replace(/\r\n?/g, "\n");

/** Apply only the changed native display interval to the raw string. Unchanged
 * prefix/suffix retain their code units, except a newly joined CR + LF boundary
 * must become LF + LF to avoid merging two logical lines. Newly typed breaks
 * follow the native textarea's LF convention. No trimming/Unicode normalization.
 * This is a local input mapping, not a merge with another writer's revision. */
export function nativeFieldText(raw: string, displayed: string): string {
  const before = nativeFieldDisplay(raw);
  if (before === displayed) return raw;
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < displayed.length && before[prefix] === displayed[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < displayed.length - prefix
    && before[before.length - 1 - suffix] === displayed[displayed.length - 1 - suffix]) suffix++;
  const rawOffset = (offset: number): number => {
    let normalized = 0, index = 0;
    while (normalized < offset && index < raw.length) {
      if (raw[index] === "\r" && raw[index + 1] === "\n") index++;
      index++; normalized++;
    }
    return index;
  };
  const pieces = [raw.slice(0, rawOffset(prefix)), displayed.slice(prefix, displayed.length - suffix), raw.slice(rawOffset(before.length - suffix))];
  return pieces.reduce((left, right) => (left.endsWith("\r") && right.startsWith("\n") ? left.slice(0, -1) + "\n" : left) + right, "");
}
