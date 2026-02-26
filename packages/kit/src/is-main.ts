export function isMainModule(importMetaUrl: string): boolean {
  return (
    importMetaUrl === `file://${process.argv[1]}` ||
    importMetaUrl === `file:///${process.argv[1]}`
  );
}
