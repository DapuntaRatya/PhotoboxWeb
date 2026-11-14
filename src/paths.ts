export const basePath = import.meta.env.BASE_URL;
export const appPath = (path: string) => basePath + path.replace(/^\//, '');
