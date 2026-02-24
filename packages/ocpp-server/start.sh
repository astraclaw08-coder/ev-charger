#!/bin/bash
set -e
export OCPP_PORT=${PORT:-9000}
exec node packages/ocpp-server/dist/index.js
