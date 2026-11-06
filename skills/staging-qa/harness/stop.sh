#!/bin/bash
# closes every browser and stops the daemon
echo 'for (const c of Object.values(S.ctx)) await c.close().catch(()=>{}); setTimeout(()=>process.exit(0),300); return "stopped";' | "$(dirname "$0")/run.sh"
