#!/bin/bash
# usage: run.sh <label>  (inside emulators:exec)
WT=/home/user/dt-solar-management/.claude/worktrees/wf_5c2a8d9c-c6e-1/admin-panel
cd $WT
VITE_USE_EMULATORS=1 VITE_EMU_FIRESTORE_PORT=8481 VITE_EMU_AUTH_PORT=9481 npx vite --config perf/vite.meter.config.ts --port 5481 --strictPort > /tmp/claude-0/-home-user-dt-solar-management/46a2c94f-b1cb-5130-9f52-a37edd76aa85/scratchpad/pc/vite.log 2>&1 &
VP=$!
for i in $(seq 1 60); do curl -s http://127.0.0.1:5481/ >/dev/null && break; sleep 1; done
cd /tmp/claude-0/-home-user-dt-solar-management/46a2c94f-b1cb-5130-9f52-a37edd76aa85/scratchpad/pc
node $WT/perf/seed-and-measure.mjs 8481 9481 http://127.0.0.1:5481 "$1" ${EXTRA}
RC=$?
pkill -P $VP; kill $VP 2>/dev/null; true
exit $RC
