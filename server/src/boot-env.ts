// boot-env.ts — side-effect module: load ~/.nodedex/.env BEFORE anything else.
//
// Imported FIRST in server.ts so this runs before any other module's top-level
// process.env reads (config consts, provider defaults, …). Precedence: a real env var /
// --env-file (dev server/.env) already in process.env WINS; this only fills the gaps a
// fresh install relies on. See home-env.ts.
import { loadHomeEnv, HOME_ENV_PATH } from "./home-env.js";

const applied = loadHomeEnv();
if (applied > 0) {
  console.error(`[boot] applied ${applied} setting(s) from ${HOME_ENV_PATH} (env / --env-file still win)`);
}
