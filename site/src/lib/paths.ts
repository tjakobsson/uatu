export const basePath = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/`;

export function sitePath(path = ""): string {
  const clean = path.replace(/^\/+/, "");
  return clean ? `${basePath}${clean}` : basePath;
}
