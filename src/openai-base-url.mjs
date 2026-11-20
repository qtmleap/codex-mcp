export function openaiBaseUrl(value) {
  if (value === undefined || value === '') return 'https://api.openai.com/v1';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid CODEX_MCP_BASE_URL');
  }
}
