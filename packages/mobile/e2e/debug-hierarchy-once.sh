#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
maestro hierarchy
