/** Domain acceptance only: always fresh in-memory PostgreSQL. Never publishes fixtures. */
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','tests/tournament-acceptance.test.ts'],{stdio:'inherit',cwd:new URL('..',import.meta.url),env:{...process.env,DATABASE_URL:'',POSTGRES_URL:'',NEON_DATABASE_URL:'',VERCEL:'',MV_EMBEDDED_DB:'1'}});
process.exit(result.status??1);
