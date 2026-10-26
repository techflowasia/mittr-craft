export function speakable(text) {
  if (!text || text !== String(text)) return '';

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_~`#]/g, '')
    .replace(/^\s*[$#>]\s*/gm, '')
    .replace(/[|&;<>]/g, ' ')
    .replace(/\\/g, '')
    .replace(/[\[\]{}()]/g, '')
    .replace(/["']/g, '')
    .replace(/https?:\/\/[^\s]+/g, ' a link ')
    .replace(/\/[\w\-./]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
