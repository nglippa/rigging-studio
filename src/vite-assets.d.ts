/** Vite asset URL imports (`import url from "file?url"`): the default export is the served URL. */
declare module "*?url" {
  const url: string;
  export default url;
}
