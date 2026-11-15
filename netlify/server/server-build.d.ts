// `tsc` runs before `react-router build` writes this file. An exact
// `declare module` path does not apply to a relative import; a wildcard
// does, both before the file exists and after.
declare module "../../build/server/*" {
  import type { ServerBuild } from "react-router";

  const build: ServerBuild;
  export = build;
}
